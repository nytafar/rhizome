import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

  test("archives existing summary.current.md to next summary.vN.md before replacing current", async () => {
    const root = await makeTempDir("rhizome-summarize-");
    const studyAssetsDir = join(root, "_assets", "smith2026archive");
    await mkdir(studyAssetsDir, { recursive: true });
    await Bun.write(join(studyAssetsDir, "summary.current.md"), "OLD CURRENT");
    await Bun.write(join(studyAssetsDir, "summary.v1.md"), "OLDER V1");
    await Bun.write(join(studyAssetsDir, "summary.v2.md"), "OLDER V2");
    await Bun.write(join(studyAssetsDir, "summary.vx.md"), "MALFORMED");
    await Bun.write(join(studyAssetsDir, "random.txt"), "IGNORE");

    const invoke: InvokeStub = async () => ({
      exitCode: 0,
      stderr: "",
      durationMs: 901,
      stdout: JSON.stringify({
        source: "abstract_only",
        tldr: "New summary text.",
        background: "Background",
        methods: "Methods",
        key_findings: "Findings",
        clinical_relevance: "Relevance",
        limitations: "Limitations",
      }),
    });

    const result = await runSummarizeStage({
      study: {
        citekey: "smith2026archive",
        title: "Archive rotation study",
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
      invoke,
    });

    const archived = await readFile(join(studyAssetsDir, "summary.v3.md"), "utf8");
    const current = await readFile(result.summaryPath, "utf8");

    expect(archived).toBe("OLD CURRENT");
    expect(current).toContain("## TL;DR\nNew summary text.");

    const filenames = await readdir(studyAssetsDir);
    expect(filenames.filter((name) => name.includes("summary.current.tmp"))).toHaveLength(0);
  });

  test("first overwrite creates summary.v1.md and second overwrite creates summary.v2.md", async () => {
    const root = await makeTempDir("rhizome-summarize-");

    const makeInvoke = (tldr: string): InvokeStub => {
      return async () => ({
        exitCode: 0,
        stderr: "",
        durationMs: 700,
        stdout: JSON.stringify({
          source: "abstract_only",
          tldr,
          background: "Background",
          methods: "Methods",
          key_findings: "Findings",
          clinical_relevance: "Relevance",
          limitations: "Limitations",
        }),
      });
    };

    const baseInput = {
      study: {
        citekey: "smith2026monotonic",
        title: "Monotonic archive study",
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
    } as const;

    await runSummarizeStage({ ...baseInput, invoke: makeInvoke("Run one") });
    await runSummarizeStage({ ...baseInput, invoke: makeInvoke("Run two") });
    await runSummarizeStage({ ...baseInput, invoke: makeInvoke("Run three") });

    const studyAssetsDir = join(root, "_assets", "smith2026monotonic");
    expect(await readFile(join(studyAssetsDir, "summary.v1.md"), "utf8")).toContain("## TL;DR\nRun one");
    expect(await readFile(join(studyAssetsDir, "summary.v2.md"), "utf8")).toContain("## TL;DR\nRun two");
    expect(await readFile(join(studyAssetsDir, "summary.current.md"), "utf8")).toContain("## TL;DR\nRun three");
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

  test("preserves abstract_only source when fulltext is present but model declines to use it", async () => {
    const root = await makeTempDir("rhizome-summarize-");
    const captured: { input?: string } = {};

    const invoke: InvokeStub = async (options) => {
      captured.input = options.input;
      return {
        exitCode: 0,
        stderr: "",
        durationMs: 850,
        stdout: JSON.stringify({
          source: "abstract_only",
          tldr: "Abstract-only output.",
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
        citekey: "doe2026modelabstract",
        title: "Model abstract-only decision",
        authors: [{ given: "John", family: "Doe" }],
        year: 2026,
        abstract: "Abstract summary.",
      },
      fulltextMarkdown: "# Full Text\nDetailed body that may be ignored.",
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
    expect(result.metadata.source).toBe("abstract_only");
    expect(result.metadata.usedFulltext).toBe(true);
    expect(captured.input).toContain("# Full Text");
    expect(captured.input).toContain("Detailed body that may be ignored.");
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
