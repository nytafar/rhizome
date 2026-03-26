import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../db/database";
import { PipelineStep } from "../../types/pipeline";
import type { PdfSourceAdapter } from "../../pdf/fetcher";
import { runPdfFetchStage, stageHandlerRegistry } from "../pdf-fetch";

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
      INSERT INTO studies (siss_id, citekey, source, title, doi, pipeline_overall, pipeline_steps_json)
      VALUES (?, ?, ?, ?, ?, ?, ?);
      `,
    )
    .run(
      sissId,
      citekey,
      "zotero",
      "PDF fetch study",
      "10.1000/example",
      "not_started",
      "{}",
    );
}

describe("runPdfFetchStage", () => {
  test("falls through sources when earlier attempts fail and deletes invalid artifacts", async () => {
    const root = await makeTempDir("rhizome-pdf-fetch-");
    const dbPath = join(root, "rhizome.sqlite");
    const assetsRoot = join(root, "assets");

    const database = new Database({ path: dbPath });
    database.init();

    const sissId = "550e8400-e29b-41d4-a716-446655440010";
    const citekey = "smith2026waterfall";
    insertStudy(database, sissId, citekey);

    const fixtureDir = join(process.cwd(), "tests", "fixtures", "pdf");
    const invalidFixture = Bun.file(join(fixtureDir, "invalid-header.bin"));
    const validFixture = Bun.file(join(fixtureDir, "valid-minimal.pdf"));

    const invalidPath = join(assetsRoot, citekey, "unpaywall-invalid.pdf");
    const validPath = join(assetsRoot, citekey, "europepmc-valid.pdf");

    const adapters: Partial<Record<"zotero" | "unpaywall" | "europepmc", PdfSourceAdapter>> = {
      zotero: {
        name: "zotero",
        async fetchPdf() {
          throw new Error("zotero attachment unavailable");
        },
      },
      unpaywall: {
        name: "unpaywall",
        async fetchPdf() {
          await Bun.write(invalidPath, await invalidFixture.bytes());
          return { filePath: invalidPath };
        },
      },
      europepmc: {
        name: "europepmc",
        async fetchPdf() {
          await Bun.write(validPath, await validFixture.bytes());
          return { filePath: validPath };
        },
      },
    };

    const result = await runPdfFetchStage({
      db: database.db,
      sissId,
      assetsRootDir: assetsRoot,
      sourceOrder: ["zotero", "unpaywall", "europepmc"],
      maxFileSizeMb: 5,
      sourceAdapters: adapters,
    });

    expect(result.pdfAvailable).toBe(true);
    expect(result.pdfSource).toBe("europepmc");
    expect(result.pdfPath).toBe(validPath);
    expect(result.attempts).toEqual([
      {
        source: "zotero",
        outcome: "error",
        detail: "zotero attachment unavailable",
      },
      {
        source: "unpaywall",
        outcome: "invalid_pdf",
        detail: "invalid_header",
      },
      {
        source: "europepmc",
        outcome: "success",
      },
    ]);

    expect(await Bun.file(invalidPath).exists()).toBe(false);
    expect(await Bun.file(validPath).exists()).toBe(true);

    database.close();
  });

  test("returns no-pdf metadata when all sources miss and preserves attempt order", async () => {
    const root = await makeTempDir("rhizome-pdf-fetch-");
    const dbPath = join(root, "rhizome.sqlite");

    const database = new Database({ path: dbPath });
    database.init();

    const sissId = "550e8400-e29b-41d4-a716-446655440011";
    insertStudy(database, sissId, "smith2026nopdf");

    const result = await runPdfFetchStage({
      db: database.db,
      sissId,
      assetsRootDir: join(root, "assets"),
      sourceOrder: ["zotero", "unpaywall", "europepmc"],
      maxFileSizeMb: 5,
      sourceAdapters: {
        zotero: { name: "zotero", async fetchPdf() { return { noPdf: true, detail: "missing_attachment" }; } },
        unpaywall: { name: "unpaywall", async fetchPdf() { return { noPdf: true, detail: "404" }; } },
        europepmc: { name: "europepmc", async fetchPdf() { return { noPdf: true, detail: "no_oa" }; } },
      },
    });

    expect(result.pdfAvailable).toBe(false);
    expect(result.pdfPath).toBeUndefined();
    expect(result.pdfSource).toBeUndefined();
    expect(result.metadata.stage).toBe(PipelineStep.PDF_FETCH);
    expect(result.attempts.map((attempt) => `${attempt.source}:${attempt.outcome}`)).toEqual([
      "zotero:no_pdf",
      "unpaywall:no_pdf",
      "europepmc:no_pdf",
    ]);

    database.close();
  });
});

describe("stageHandlerRegistry", () => {
  test("wires pdf_fetch handler under PipelineStep.PDF_FETCH", () => {
    expect(stageHandlerRegistry[PipelineStep.PDF_FETCH]).toBe(runPdfFetchStage);
  });
});
