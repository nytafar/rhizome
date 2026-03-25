import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { invokeClaudeCode, type ClaudeCodeResult } from "../ai/executor";
import { buildSummarizerInput, type SummarizerInputStudy } from "../ai/input-builder";
import { summarizerJsonSchema } from "../ai/schemas/summarizer";
import {
  summaryJsonToMarkdown,
  type SkillMeta,
  type SummarizerOutput,
} from "../ai/summary-converter";
import { PipelineStep } from "../types/pipeline";

const DEFAULT_PROMPT_TEXT = "Process this study according to your instructions.";

type InvokeClaudeCodeLike = (
  options: Parameters<typeof invokeClaudeCode>[0],
) => Promise<ClaudeCodeResult>;

export interface SummarizeStageStudyInput extends SummarizerInputStudy {
  citekey: string;
}

export interface SummarizeStageInput {
  study: SummarizeStageStudyInput;
  fulltextMarkdown?: string;
  assetsRootDir?: string;
  skillsDir: string;
  summarizerSkillFile: string;
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

export interface SummarizeStageResult {
  summaryPath: string;
  markdown: string;
  output: SummarizerOutput;
  metadata: {
    stage: PipelineStep.SUMMARIZE;
    durationMs: number;
    model: string;
    skillVersion: string;
    source: SummarizerOutput["source"];
    usedFulltext: boolean;
  };
}

function buildStageInputMarkdown(params: {
  study: SummarizeStageStudyInput;
  fulltextMarkdown?: string;
}): string {
  const metadataAndAbstract = buildSummarizerInput(params.study).trimEnd();
  const fulltext = params.fulltextMarkdown?.trim();

  if (!fulltext) {
    return metadataAndAbstract;
  }

  return `${metadataAndAbstract}\n\n# Full Text\n${fulltext}\n`;
}

function parseSummarizerOutput(stdout: string): SummarizerOutput {
  const parsed = JSON.parse(stdout) as unknown;

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Summarizer output must be a JSON object");
  }

  const candidate = parsed as Partial<SummarizerOutput>;
  const requiredStringFields: Array<keyof SummarizerOutput> = [
    "source",
    "tldr",
    "background",
    "methods",
    "key_findings",
    "clinical_relevance",
    "limitations",
  ];

  for (const field of requiredStringFields) {
    const value = candidate[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Summarizer output missing required field: ${field}`);
    }
  }

  if (candidate.source !== "fulltext" && candidate.source !== "abstract_only") {
    throw new Error(`Summarizer output has invalid source: ${String(candidate.source)}`);
  }

  return candidate as SummarizerOutput;
}

export async function runSummarizeStage(
  input: SummarizeStageInput,
): Promise<SummarizeStageResult> {
  const usedFulltext = Boolean(input.fulltextMarkdown?.trim());
  const invoke = input.invoke ?? invokeClaudeCode;

  const markdownInput = buildStageInputMarkdown({
    study: input.study,
    fulltextMarkdown: input.fulltextMarkdown,
  });

  const skillFilePath = join(input.skillsDir, input.summarizerSkillFile);
  const assetsRoot = input.assetsRootDir ?? "_assets";
  const studyAssetsDir = join(assetsRoot, input.study.citekey);
  const summaryPath = join(studyAssetsDir, "summary.current.md");
  const debugDir = input.debugDir ?? join(studyAssetsDir, "debug");

  const result = await invoke({
    claudeBinary: input.claudeBinary,
    systemPromptFile: skillFilePath,
    jsonSchema: summarizerJsonSchema,
    maxTurns: input.maxTurns,
    timeoutMs: input.timeoutMs,
    input: markdownInput,
    promptText: input.promptText ?? DEFAULT_PROMPT_TEXT,
    debugDir,
  });

  const parsed = parseSummarizerOutput(result.stdout);
  const normalizedOutput: SummarizerOutput = usedFulltext
    ? parsed
    : {
        ...parsed,
        source: "abstract_only",
      };

  const generatedAt = (input.now ?? new Date()).toISOString();
  const meta: SkillMeta = {
    citekey: input.study.citekey,
    skillVersion: input.skillVersion,
    model: input.model,
    generatedAt,
  };

  const markdown = summaryJsonToMarkdown(normalizedOutput, meta);

  mkdirSync(studyAssetsDir, { recursive: true });
  await Bun.write(summaryPath, markdown);

  return {
    summaryPath,
    markdown,
    output: normalizedOutput,
    metadata: {
      stage: PipelineStep.SUMMARIZE,
      durationMs: result.durationMs,
      model: input.model,
      skillVersion: input.skillVersion,
      source: normalizedOutput.source,
      usedFulltext,
    },
  };
}

export type StageHandler = (input: SummarizeStageInput) => Promise<SummarizeStageResult>;

export const stageHandlerRegistry: Partial<Record<PipelineStep, StageHandler>> = {
  [PipelineStep.SUMMARIZE]: runSummarizeStage,
};
