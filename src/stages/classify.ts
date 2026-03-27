import matter from "gray-matter";
import { dirname, join } from "node:path";
import {
  invokeClaudeCode,
  type ClaudeCodeResult,
  type ClaudeCodeInvocationError,
} from "../ai/executor";
import {
  classifierJsonSchema,
  parseClassifierStdout,
  type ClassifierOutput,
} from "../ai/schemas/classifier";
import { PipelineStep } from "../types/pipeline";

const DEFAULT_PROMPT_TEXT = "Classify this study according to your instructions.";

type InvokeClaudeCodeLike = (
  options: Parameters<typeof invokeClaudeCode>[0],
) => Promise<ClaudeCodeResult>;

export interface ClassifyStageStudyInput {
  citekey: string;
  title: string;
  doi?: string;
  pmid?: string;
}

export interface ClassifyStageInput {
  study: ClassifyStageStudyInput;
  assetsRootDir?: string;
  summaryPath?: string;
  skillsDir: string;
  classifierSkillFile: string;
  skillVersion: string;
  model: string;
  claudeBinary?: string;
  timeoutMs: number;
  maxTurns: number;
  promptText?: string;
  debugDir?: string;
  now?: Date;
  invoke?: InvokeClaudeCodeLike;
}

export interface ClassifyStageResult {
  summaryPath: string;
  output: ClassifierOutput;
  metadata: {
    stage: PipelineStep.CLASSIFY;
    durationMs: number;
    model: string;
    skillVersion: string;
    generatedAt: string;
    source: ClassifierOutput["source"];
    provisionalCount: number;
    provisional: ClassifierOutput["tier_7_provisional"];
    tier_4: ClassifierOutput["tier_4"];
    tier_5: ClassifierOutput["tier_5"];
    tier_6_taxonomy: ClassifierOutput["tier_6_taxonomy"];
    tier_7_provisional: ClassifierOutput["tier_7_provisional"];
  };
}

export class ClassifyStageError extends Error {
  readonly errorClass: "transient" | "permanent";
  readonly code: string;

  constructor(message: string, code: string, errorClass: "transient" | "permanent") {
    super(message);
    this.name = "ClassifyStageError";
    this.code = code;
    this.errorClass = errorClass;
  }
}

function buildSummaryPath(input: ClassifyStageInput): string {
  if (input.summaryPath && input.summaryPath.trim().length > 0) {
    return input.summaryPath;
  }

  const assetsRoot = input.assetsRootDir ?? "_assets";
  return join(assetsRoot, input.study.citekey, "summary.current.md");
}

function extractStructuredExtractionBlock(summaryMarkdown: string): string {
  const heading = "## Structured Extraction";
  const headingIndex = summaryMarkdown.indexOf(heading);
  if (headingIndex === -1) {
    throw new ClassifyStageError(
      "Classify stage parse error: missing '## Structured Extraction' section in summary.current.md",
      "summary_missing_structured_extraction",
      "permanent",
    );
  }

  const sectionContent = summaryMarkdown.slice(headingIndex + heading.length);
  const fencedJsonMatch = /```json\s*([\s\S]*?)\s*```/m.exec(sectionContent);
  if (!fencedJsonMatch || !fencedJsonMatch[1]) {
    throw new ClassifyStageError(
      "Classify stage parse error: missing JSON code block under '## Structured Extraction'",
      "summary_missing_structured_extraction_json",
      "permanent",
    );
  }

  return fencedJsonMatch[1].trim();
}

function parseStructuredExtraction(summaryMarkdown: string): unknown {
  const rawJsonBlock = extractStructuredExtractionBlock(summaryMarkdown);

  try {
    return JSON.parse(rawJsonBlock) as unknown;
  } catch (error) {
    throw new ClassifyStageError(
      `Classify stage parse error: invalid structured extraction JSON (${String(error)})`,
      "summary_invalid_structured_extraction_json",
      "permanent",
    );
  }
}

function parseSummarySource(summaryMarkdown: string): "fulltext" | "abstract_only" | undefined {
  try {
    const parsed = matter(summaryMarkdown);
    const source = parsed.data?.source;
    if (source === "fulltext" || source === "abstract_only") {
      return source;
    }
  } catch {
    // Ignore frontmatter parsing errors. Structured extraction parsing is authoritative.
  }

  return undefined;
}

function buildClassifierInput(params: {
  study: ClassifyStageStudyInput;
  summarySource?: "fulltext" | "abstract_only";
  structuredExtraction: unknown;
}): string {
  const extractionJson = JSON.stringify(params.structuredExtraction, null, 2);
  const sourceLabel = params.summarySource ?? "unknown";

  return [
    "# Study Metadata",
    `Citekey: ${params.study.citekey}`,
    `Title: ${params.study.title}`,
    `DOI: ${params.study.doi ?? "Unknown"}`,
    `PMID: ${params.study.pmid ?? "Unknown"}`,
    `Summary Source: ${sourceLabel}`,
    "",
    "# Structured Extraction",
    "```json",
    extractionJson,
    "```",
    "",
  ].join("\n");
}

function classifyInvocationError(error: unknown): never {
  const maybe = error as ClaudeCodeInvocationError & { message?: string; name?: string };
  const message = typeof maybe?.message === "string" ? maybe.message : String(error);
  const lowered = message.toLowerCase();
  const transient =
    lowered.includes("timeout")
    || lowered.includes("timed out")
    || lowered.includes("rate limit")
    || lowered.includes("temporarily unavailable")
    || lowered.includes("connection");

  throw new ClassifyStageError(
    `Classify model invocation failed: ${message}`,
    transient ? "classifier_invocation_timeout" : "classifier_invocation_failed",
    transient ? "transient" : "permanent",
  );
}

export async function runClassifyStage(input: ClassifyStageInput): Promise<ClassifyStageResult> {
  const summaryPath = buildSummaryPath(input);
  const summaryFile = Bun.file(summaryPath);

  if (!(await summaryFile.exists())) {
    throw new ClassifyStageError(
      `Classify stage requires summarize artifact at ${summaryPath}; run summarize first or repair missing summary.current.md`,
      "summary_missing",
      "permanent",
    );
  }

  const skillFilePath = join(input.skillsDir, input.classifierSkillFile);
  const skillFile = Bun.file(skillFilePath);
  if (!(await skillFile.exists())) {
    throw new ClassifyStageError(
      `Classifier skill file not found: ${skillFilePath}`,
      "classifier_skill_missing",
      "permanent",
    );
  }

  const summaryMarkdown = await summaryFile.text();
  const structuredExtraction = parseStructuredExtraction(summaryMarkdown);
  const summarySource = parseSummarySource(summaryMarkdown);

  const invoke = input.invoke ?? invokeClaudeCode;
  const classifierInput = buildClassifierInput({
    study: input.study,
    summarySource,
    structuredExtraction,
  });

  const debugDir = input.debugDir ?? join(dirname(summaryPath), "debug");

  let result: ClaudeCodeResult;
  try {
    result = await invoke({
      claudeBinary: input.claudeBinary,
      systemPromptFile: skillFilePath,
      jsonSchema: classifierJsonSchema,
      maxTurns: input.maxTurns,
      timeoutMs: input.timeoutMs,
      input: classifierInput,
      promptText: input.promptText ?? DEFAULT_PROMPT_TEXT,
      debugDir,
    });
  } catch (error) {
    classifyInvocationError(error);
  }

  let output: ClassifierOutput;
  try {
    output = parseClassifierStdout(result.stdout);
  } catch (error) {
    throw new ClassifyStageError(
      `Classify stage malformed model output (schema/json parse): ${String(error)}`,
      "classifier_output_malformed",
      "permanent",
    );
  }

  const generatedAt = (input.now ?? new Date()).toISOString();

  return {
    summaryPath,
    output,
    metadata: {
      stage: PipelineStep.CLASSIFY,
      durationMs: result.durationMs,
      model: input.model,
      skillVersion: input.skillVersion,
      generatedAt,
      source: output.source,
      provisionalCount: output.tier_7_provisional.length,
      provisional: output.tier_7_provisional,
      tier_4: output.tier_4,
      tier_5: output.tier_5,
      tier_6_taxonomy: output.tier_6_taxonomy,
      tier_7_provisional: output.tier_7_provisional,
    },
  };
}

export type ClassifyStageHandler = (input: ClassifyStageInput) => Promise<ClassifyStageResult>;

export const stageHandlerRegistry: Partial<Record<PipelineStep, ClassifyStageHandler>> = {
  [PipelineStep.CLASSIFY]: runClassifyStage,
};
