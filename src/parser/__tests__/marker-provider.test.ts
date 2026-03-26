import matter from "gray-matter";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineStep } from "../../types/pipeline";
import {
  MarkerProvider,
  MarkerProviderError,
  type MarkerProviderSubprocessRunner,
} from "../marker-provider";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createProvider(runSubprocess: MarkerProviderSubprocessRunner): MarkerProvider {
  return new MarkerProvider({
    markerBinary: "/tmp/.siss-env/bin/marker_single",
    markerVersion: "1.6.0",
    defaultTimeoutMs: 30_000,
    defaultForceOcr: false,
    runSubprocess,
    now: () => new Date("2026-03-26T18:00:00.000Z"),
  });
}

async function expectMarkerProviderError(
  operation: Promise<unknown>,
  assertError: (error: MarkerProviderError) => void,
): Promise<void> {
  try {
    await operation;
    throw new Error("Expected MarkerProviderError but operation resolved.");
  } catch (error) {
    expect(error).toBeInstanceOf(MarkerProviderError);
    if (!(error instanceof MarkerProviderError)) {
      throw error;
    }

    assertError(error);
  }
}

describe("MarkerProvider", () => {
  test("parse writes canonical fulltext markdown with frontmatter and rewrites figure links", async () => {
    const root = await makeTempDir("rhizome-marker-provider-");
    const outputDir = join(root, "_assets", "smith2026ashwagandha");
    const pdfPath = join(root, "source.pdf");

    await mkdir(outputDir, { recursive: true });
    await Bun.write(pdfPath, "%PDF-1.4\n");

    const provider = createProvider(async (request) => {
      const outputDirFlagIndex = request.args.findIndex((arg) => arg === "--output_dir");
      const markerOutputRoot = request.args[outputDirFlagIndex + 1];

      if (!markerOutputRoot) {
        throw new Error("Missing --output_dir argument");
      }

      const markerStudyDir = join(markerOutputRoot, "source");
      await mkdir(markerStudyDir, { recursive: true });
      await Bun.write(join(markerStudyDir, "figure one.png"), "image-bytes");
      await Bun.write(
        join(markerStudyDir, "source.md"),
        [
          "# Results",
          "",
          "| col | val |",
          "| --- | --- |",
          "| a | b |",
          "",
          "![Figure 1](figure one.png)",
          "![Missing](not-here.png)",
          "{#page_1}",
          "{#page_2}",
        ].join("\n"),
      );

      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    });

    const result = await provider.parse(pdfPath, outputDir, { forceOcr: true });

    expect(result.markdownPath).toBe(join(outputDir, "fulltext.md"));
    expect(result.metadata.stage).toBe(PipelineStep.FULLTEXT_MARKER);
    expect(result.metadata.provider).toBe("marker");
    expect(result.metadata.providerVersion).toBe("1.6.0");
    expect(result.metadata.parsedAt).toBe("2026-03-26T18:00:00.000Z");
    expect(result.metadata.pageCount).toBe(2);
    expect(result.metadata.hasImages).toBe(true);
    expect(result.metadata.hasTables).toBe(true);

    const fulltext = await readFile(result.markdownPath, "utf8");
    const parsed = matter(fulltext);

    expect(parsed.data).toEqual({
      note_type: "study_fulltext",
      study_ref: "smith2026ashwagandha",
      parser_provider: "marker",
      parser_version: "1.6.0",
      parsed_at: "2026-03-26T18:00:00.000Z",
      page_count: 2,
      has_tables: true,
      has_images: true,
    });
    expect(parsed.content).toContain("![Figure 1](figures/figure-one.png)");
    expect(parsed.content).toContain("![Missing](not-here.png)");

    expect(await Bun.file(join(outputDir, "figures", "figure-one.png")).exists()).toBe(true);
  });

  test("parse reports subprocess non-zero exit with stderr context", async () => {
    const root = await makeTempDir("rhizome-marker-provider-");
    const outputDir = join(root, "_assets", "doe2026");
    const pdfPath = join(root, "source.pdf");

    await mkdir(outputDir, { recursive: true });
    await Bun.write(pdfPath, "%PDF-1.4\n");

    const provider = createProvider(async () => ({
      exitCode: 7,
      stdout: "",
      stderr: "marker crashed on page 2",
    }));

    await expectMarkerProviderError(provider.parse(pdfPath, outputDir), (error) => {
      expect(error.context.code).toBe("subprocess_non_zero_exit");
      expect(error.context.exitCode).toBe(7);
      expect(error.context.stderr).toContain("marker crashed on page 2");
      expect(error.message).toContain("exit code 7");
    });
  });

  test("parse reports subprocess timeout with deterministic timeout context", async () => {
    const root = await makeTempDir("rhizome-marker-provider-");
    const outputDir = join(root, "_assets", "timeout2026");
    const pdfPath = join(root, "source.pdf");

    await mkdir(outputDir, { recursive: true });
    await Bun.write(pdfPath, "%PDF-1.4\n");

    const provider = createProvider(async () => {
      const timeoutError = new Error("timed out");
      timeoutError.name = "MarkerSubprocessTimeoutError";
      Object.assign(timeoutError, {
        command: "/tmp/.siss-env/bin/marker_single",
        args: ["--help"],
        timeoutMs: 5_000,
      });
      throw timeoutError;
    });

    await expectMarkerProviderError(provider.parse(pdfPath, outputDir), (error) => {
      expect(error.context.code).toBe("subprocess_timeout");
      expect(error.context.timeoutMs).toBe(5_000);
      expect(error.message).toContain("timed out");
    });
  });

  test("parse fails when expected marker markdown output is missing", async () => {
    const root = await makeTempDir("rhizome-marker-provider-");
    const outputDir = join(root, "_assets", "missing-output");
    const pdfPath = join(root, "source.pdf");

    await mkdir(outputDir, { recursive: true });
    await Bun.write(pdfPath, "%PDF-1.4\n");

    const provider = createProvider(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    await expectMarkerProviderError(provider.parse(pdfPath, outputDir), (error) => {
      expect(error.context.code).toBe("missing_output_markdown");
      expect(error.context.expectedPath).toContain("source/source.md");
    });
  });

  test("parse fails on malformed markdown image refs", async () => {
    const root = await makeTempDir("rhizome-marker-provider-");
    const outputDir = join(root, "_assets", "malformed");
    const pdfPath = join(root, "source.pdf");

    await mkdir(outputDir, { recursive: true });
    await Bun.write(pdfPath, "%PDF-1.4\n");

    const provider = createProvider(async (request) => {
      const outputDirFlagIndex = request.args.findIndex((arg) => arg === "--output_dir");
      const markerOutputRoot = request.args[outputDirFlagIndex + 1];
      if (!markerOutputRoot) {
        throw new Error("Missing --output_dir argument");
      }

      const markerStudyDir = join(markerOutputRoot, "source");
      await mkdir(markerStudyDir, { recursive: true });
      await Bun.write(join(markerStudyDir, "source.md"), "![Broken]()");

      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    });

    await expectMarkerProviderError(provider.parse(pdfPath, outputDir), (error) => {
      expect(error.context.code).toBe("malformed_markdown_image_ref");
      expect(error.context.imageRef).toBe("");
    });
  });

  test("healthcheck returns false when subprocess exits non-zero", async () => {
    const provider = createProvider(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "marker unavailable",
    }));

    await expect(provider.healthcheck()).resolves.toBe(false);
  });
});
