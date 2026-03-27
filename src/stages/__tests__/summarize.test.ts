import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  invokeClaudeCode,
  type ClaudeCodeResult,
} from "../../ai/executor";
import { PipelineStep } from "../../types/pipeline";
import { runSummarizeStage, stageHandlerRegistry } from "../summarize";

type InvokeStub = (
  options: Parameters<typeof invokeClaudeCode>[0],
) => Promise<ClaudeCodeResult>;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("runSummarizeStage", () => {
  test("writes summary.current.md to _assets/{citekey} and normalizes abstract-only source", async () => {
    const root = await makeTempDir("rhizome-summarize-");
    const captured: { input?: string; systemPromptFile?: string } = {};

    const invoke: InvokeStub = async (options) => {
      captured.input = options.input;
      captured.systemPromptFile = options.systemPromptFile;

      return {
        exitCode: 0,
        stderr: "",
        durationMs: 2475,
        stdout: JSON.stringify({
          source: "fulltext",
          tldr: "Abstract-level summary.",
          background: "Background",
          methods: "Methods",
          key_findings: "Findings",
          clinical_relevance: "Relevance",
          limitations: "No full text available.",
        }),
      };
    };

    const result = await runSummarizeStage({
      study: {
        citekey: "smith2026adaptogen",
        title: "Adaptogen study",
        authors: [{ given: "Jane", family: "Smith" }],
        year: 2026,
        abstract: "Abstract body.",
      },
      assetsRootDir: join(root, "_assets"),
      skillsDir: ".siss/skills",
      summarizerSkillFile: "summarizer.md",
      skillVersion: "1.0",
      model: "claude-sonnet-4",
      maxTurns: 10,
      timeoutMs: 30_000,
      now: new Date("2026-03-25T22:40:00.000Z"),
      invoke,
    });

    const expectedPath = join(
      root,
      "_assets",
      "smith2026adaptogen",
      "summary.current.md",
    );

    expect(result.summaryPath).toBe(expectedPath);
    expect(result.output.source).toBe("abstract_only");
    expect(result.metadata.durationMs).toBe(2475);
    expect(result.metadata.model).toBe("claude-sonnet-4");
    expect(result.metadata.stage).toBe(PipelineStep.SUMMARIZE);
    expect(result.metadata.usedFulltext).toBe(false);

    expect(captured.systemPromptFile).toBe(".siss/skills/summarizer.md");
    expect(captured.input).toContain("# Study Metadata");
    expect(captured.input).toContain("# Abstract");
    expect(captured.input).not.toContain("# Full Text");

    const written = await readFile(expectedPath, "utf8");
    expect(written).toContain('study_ref: smith2026adaptogen');
    expect(written).toContain('source: "abstract_only"');
    expect(written).toContain("## TL;DR\nAbstract-level summary.");
  });

  test("includes full text in prompt input when provided", async () => {
    const root = await makeTempDir("rhizome-summarize-");
    const captured: { input?: string } = {};

    const invoke: InvokeStub = async (options) => {
      captured.input = options.input;
      return {
        exitCode: 0,
        stderr: "",
        durationMs: 900,
        stdout: JSON.stringify({
          source: "fulltext",
          tldr: "Fulltext summary.",
          background: "Background",
          methods: "Methods",
          key_findings: "Findings",
          clinical_relevance: "Relevance",
          limitations: "Limitations",
        }),
      };
    };

    const result = await runSummarizeStage({
      study: {
        citekey: "doe2026fulltext",
        title: "Fulltext study",
        authors: [{ given: "John", family: "Doe" }],
        year: 2026,
        abstract: "Abstract summary.",
      },
      fulltextMarkdown: "# Body\nDetailed full text.",
      assetsRootDir: join(root, "_assets"),
      skillsDir: ".siss/skills",
      summarizerSkillFile: "summarizer.md",
      skillVersion: "1.0",
      model: "claude-opus-4-5",
      maxTurns: 10,
      timeoutMs: 30_000,
      invoke,
    });

    expect(result.output.source).toBe("fulltext");
    expect(result.metadata.usedFulltext).toBe(true);
    expect(captured.input).toContain("# Full Text");
    expect(captured.input).toContain("Detailed full text.");
  });

  test("treats whitespace-only fulltext markdown as abstract-only fallback", async () => {
    const root = await makeTempDir("rhizome-summarize-");
    const captured: { input?: string } = {};

    const invoke: InvokeStub = async (options) => {
      captured.input = options.input;
      return {
        exitCode: 0,
        stderr: "",
        durationMs: 800,
        stdout: JSON.stringify({
          source: "fulltext",
          tldr: "Fallback summary.",
          background: "Background",
          methods: "Methods",
          key_findings: "Findings",
          clinical_relevance: "Relevance",
          limitations: "Limitations",
        }),
      };
    };

    const result = await runSummarizeStage({
      study: {
        citekey: "doe2026whitespace",
        title: "Whitespace fulltext",
        authors: [{ given: "John", family: "Doe" }],
        year: 2026,
        abstract: "Abstract summary.",
      },
      fulltextMarkdown: "  \n\n\t",
      assetsRootDir: join(root, "_assets"),
      skillsDir: ".siss/skills",
      summarizerSkillFile: "summarizer.md",
      skillVersion: "1.0",
      model: "claude-opus-4-5",
      maxTurns: 10,
      timeoutMs: 30_000,
      invoke,
    });

    expect(result.output.source).toBe("abstract_only");
    expect(result.metadata.usedFulltext).toBe(false);
    expect(captured.input).toContain("# Abstract");
    expect(captured.input).not.toContain("# Full Text");
  });
});

describe("stageHandlerRegistry", () => {
  test("wires summarize handler under PipelineStep.SUMMARIZE", () => {
    expect(stageHandlerRegistry[PipelineStep.SUMMARIZE]).toBe(runSummarizeStage);
  });
});
