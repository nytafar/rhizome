import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../db/database";
import { ParserRegistry } from "../../parser/registry";
import { PipelineOverallStatus, PipelineStep } from "../../types/pipeline";
import type { MarkdownProvider } from "../../parser/types";
import {
  runFulltextMarkerStage,
  stageHandlerRegistry,
} from "../fulltext-marker";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function insertStudy(database: Database, sissId: string, citekey: string): void {
  database.db
    .query(
      `
      INSERT INTO studies (siss_id, citekey, source, title, pipeline_overall, pipeline_steps_json)
      VALUES (?, ?, ?, ?, ?, ?);
      `,
    )
    .run(
      sissId,
      citekey,
      "zotero",
      "Fulltext marker study",
      PipelineOverallStatus.NOT_STARTED,
      "{}",
    );
}

function insertPdfFetchJob(database: Database, sissId: string, metadata: unknown): void {
  database.db
    .query(
      `
      INSERT INTO jobs (siss_id, stage, status, metadata, completed_at)
      VALUES (?, ?, 'complete', ?, datetime('now'));
      `,
    )
    .run(sissId, PipelineStep.PDF_FETCH, JSON.stringify(metadata));
}

function createRegistry(provider: MarkdownProvider): ParserRegistry {
  return new ParserRegistry({
    activeProviderId: "marker",
    providers: [provider],
  });
}

describe("runFulltextMarkerStage", () => {
  test("returns deterministic no-PDF skip metadata when pdf_fetch metadata is absent", async () => {
    const root = await makeTempDir("rhizome-fulltext-marker-");
    const database = new Database({ path: join(root, "rhizome.sqlite") });
    database.init();

    const sissId = "550e8400-e29b-41d4-a716-446655440030";
    insertStudy(database, sissId, "smith2026nopdf");

    const providerCalls: Array<{ pdfPath: string; outputDir: string }> = [];
    const registry = createRegistry({
      id: "marker",
      name: "Marker PDF",
      async parse(pdfPath, outputDir) {
        providerCalls.push({ pdfPath, outputDir });
        return {
          markdownPath: join(outputDir, "fulltext.md"),
          metadata: {
            stage: PipelineStep.FULLTEXT_MARKER,
            provider: "marker",
            providerVersion: "1.6.0",
            parsedAt: "2026-03-27T00:00:00.000Z",
            pageCount: 1,
            hasImages: false,
            hasTables: false,
          },
        };
      },
      async healthcheck() {
        return true;
      },
    });

    const result = await runFulltextMarkerStage({
      db: database.db,
      sissId,
      assetsRootDir: join(root, "assets"),
      parserRegistry: registry,
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no_pdf");
    expect(result.metadata).toEqual({
      stage: PipelineStep.FULLTEXT_MARKER,
      skipped: true,
      reason: "no_pdf",
    });
    expect(providerCalls.length).toBe(0);

    database.close();
  });

  test("treats malformed pdf_fetch metadata as deterministic no-PDF skip branch", async () => {
    const root = await makeTempDir("rhizome-fulltext-marker-");
    const database = new Database({ path: join(root, "rhizome.sqlite") });
    database.init();

    const sissId = "550e8400-e29b-41d4-a716-446655440031";
    insertStudy(database, sissId, "doe2026malformed");

    database.db
      .query(
        `
        INSERT INTO jobs (siss_id, stage, status, metadata, completed_at)
        VALUES (?, ?, 'complete', ?, datetime('now'));
        `,
      )
      .run(sissId, PipelineStep.PDF_FETCH, "{not-json}");

    const registry = createRegistry({
      id: "marker",
      name: "Marker PDF",
      async parse() {
        throw new Error("parse should not be called for malformed metadata");
      },
      async healthcheck() {
        return true;
      },
    });

    const result = await runFulltextMarkerStage({
      db: database.db,
      sissId,
      assetsRootDir: join(root, "assets"),
      parserRegistry: registry,
    });

    expect(result.metadata.skipped).toBe(true);
    expect(result.metadata.reason).toBe("no_pdf");

    database.close();
  });

  test("calls active parser provider when pdf_fetch reports an available pdf", async () => {
    const root = await makeTempDir("rhizome-fulltext-marker-");
    const database = new Database({ path: join(root, "rhizome.sqlite") });
    database.init();

    const sissId = "550e8400-e29b-41d4-a716-446655440032";
    const citekey = "lane2026fulltext";
    insertStudy(database, sissId, citekey);

    const pdfPath = join(root, "assets", citekey, "paper.pdf");
    insertPdfFetchJob(database, sissId, {
      stage: PipelineStep.PDF_FETCH,
      pdfAvailable: true,
      pdfPath,
      pdfSource: "unpaywall",
      attempts: [{ source: "unpaywall", outcome: "success" }],
    });

    const calls: Array<{ pdfPath: string; outputDir: string }> = [];
    const registry = createRegistry({
      id: "marker",
      name: "Marker PDF",
      async parse(inputPdfPath, outputDir) {
        calls.push({ pdfPath: inputPdfPath, outputDir });
        return {
          markdownPath: join(outputDir, "fulltext.md"),
          metadata: {
            stage: PipelineStep.FULLTEXT_MARKER,
            provider: "marker",
            providerVersion: "1.6.0",
            parsedAt: "2026-03-27T00:05:00.000Z",
            pageCount: 9,
            hasImages: true,
            hasTables: true,
          },
        };
      },
      async healthcheck() {
        return true;
      },
    });

    const result = await runFulltextMarkerStage({
      db: database.db,
      sissId,
      assetsRootDir: join(root, "assets"),
      parserRegistry: registry,
    });

    expect(result.skipped).toBe(false);
    expect(result.fulltextPath).toBe(join(root, "assets", citekey, "fulltext.md"));
    expect(result.metadata).toEqual({
      stage: PipelineStep.FULLTEXT_MARKER,
      skipped: false,
      pdfPath,
      fulltextPath: join(root, "assets", citekey, "fulltext.md"),
      provider: "marker",
      providerVersion: "1.6.0",
      parsedAt: "2026-03-27T00:05:00.000Z",
      pageCount: 9,
      hasImages: true,
      hasTables: true,
    });

    expect(calls).toEqual([
      {
        pdfPath,
        outputDir: join(root, "assets", citekey),
      },
    ]);

    database.close();
  });

  test("propagates provider errors with context", async () => {
    const root = await makeTempDir("rhizome-fulltext-marker-");
    const database = new Database({ path: join(root, "rhizome.sqlite") });
    database.init();

    const sissId = "550e8400-e29b-41d4-a716-446655440033";
    insertStudy(database, sissId, "rivera2026failure");

    insertPdfFetchJob(database, sissId, {
      stage: PipelineStep.PDF_FETCH,
      pdfAvailable: true,
      pdfPath: join(root, "assets", "rivera2026failure", "paper.pdf"),
    });

    const registry = createRegistry({
      id: "marker",
      name: "Marker PDF",
      async parse() {
        throw new Error("marker timeout: subprocess exceeded 30000ms");
      },
      async healthcheck() {
        return true;
      },
    });

    await expect(
      runFulltextMarkerStage({
        db: database.db,
        sissId,
        assetsRootDir: join(root, "assets"),
        parserRegistry: registry,
      }),
    ).rejects.toThrow("marker timeout");

    database.close();
  });

  test("rejects invalid provider parse results", async () => {
    const root = await makeTempDir("rhizome-fulltext-marker-");
    const database = new Database({ path: join(root, "rhizome.sqlite") });
    database.init();

    const sissId = "550e8400-e29b-41d4-a716-446655440034";
    insertStudy(database, sissId, "nguyen2026invalid");

    insertPdfFetchJob(database, sissId, {
      stage: PipelineStep.PDF_FETCH,
      pdfAvailable: true,
      pdfPath: join(root, "assets", "nguyen2026invalid", "paper.pdf"),
    });

    const registry = createRegistry({
      id: "marker",
      name: "Marker PDF",
      async parse() {
        return {
          markdownPath: "",
          metadata: {
            stage: PipelineStep.FULLTEXT_MARKER,
            provider: "marker",
            providerVersion: "1.6.0",
            parsedAt: "2026-03-27T00:05:00.000Z",
            pageCount: 9,
            hasImages: true,
            hasTables: true,
          },
        };
      },
      async healthcheck() {
        return true;
      },
    });

    await expect(
      runFulltextMarkerStage({
        db: database.db,
        sissId,
        assetsRootDir: join(root, "assets"),
        parserRegistry: registry,
      }),
    ).rejects.toThrow("markdownPath is required");

    database.close();
  });
});

describe("stageHandlerRegistry", () => {
  test("wires fulltext.marker handler under PipelineStep.FULLTEXT_MARKER", () => {
    expect(stageHandlerRegistry[PipelineStep.FULLTEXT_MARKER]).toBe(runFulltextMarkerStage);
  });
});
