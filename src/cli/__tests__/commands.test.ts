import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../db/database";
import { WriterLock } from "../../lock/writer-lock";
import { parseStudyFrontmatter } from "../../schema/frontmatter";
import { PipelineOverallStatus, PipelineStep, PipelineStepStatus } from "../../types/pipeline";
import { runInitCommand } from "../commands/init";
import { runSyncZoteroCommand } from "../commands/sync";
import { runProcessCommand } from "../commands/process";
import { runStatusCommand } from "../commands/status";
import { runLockClearCommand, runLockStatusCommand } from "../commands/lock";
import { CANONICAL_WORKSPACE_DIR, LEGACY_WORKSPACE_DIR } from "../../config/workspace-contract";
import type { ZoteroItem } from "../../zotero/client";

const INIT_ARGS = {
  nonInteractive: true,
  researchRoot: "Research",
  zoteroUser: "12345",
  zoteroKeyEnv: "ZOTERO_API_KEY",
  unpaywallEmail: "test@example.com",
  aiWindows: "17:00-19:00,23:00-01:00",
  timezone: "Europe/Oslo",
  force: true,
} as const;

async function withTempRhizome<T>(run: (root: string, vaultPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "rhizome-cli-commands-"));
  const previousZoteroKey = process.env.ZOTERO_API_KEY;

  try {
    process.env.ZOTERO_API_KEY = "test-zotero-key";

    const vaultPath = join(root, "vault");
    await mkdir(vaultPath, { recursive: true });

    await runInitCommand(
      {
        ...INIT_ARGS,
        vault: vaultPath,
      },
      {
        cwd: root,
        runSubprocess: async () => ({
          exitCode: 0,
          stdout: "ok\n",
          stderr: "",
        }),
      },
    );

    return await run(root, vaultPath);
  } finally {
    if (previousZoteroKey === undefined) {
      delete process.env.ZOTERO_API_KEY;
    } else {
      process.env.ZOTERO_API_KEY = previousZoteroKey;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function makeFakeClient(items: ZoteroItem[]) {
  return {
    async *getItemsSince() {
      for (const item of items) {
        yield item;
      }
    },
    async getCollections() {
      return new Map<string, string>([["COLL_A", "Adaptogens"]]);
    },
    async getDeletedSince() {
      return { keys: [], libraryVersion: 42 };
    },
  };
}

async function moveConfigToLegacyWorkspace(root: string, rewriteWorkspacePaths = false): Promise<void> {
  const canonicalConfigPath = join(root, CANONICAL_WORKSPACE_DIR, "config.yaml");
  const legacyConfigPath = join(root, LEGACY_WORKSPACE_DIR, "config.yaml");

  const canonicalConfig = await Bun.file(canonicalConfigPath).text();
  const legacyConfig = rewriteWorkspacePaths
    ? canonicalConfig
        .replaceAll(`${CANONICAL_WORKSPACE_DIR}/locks/mutator.lock`, `${LEGACY_WORKSPACE_DIR}/locks/mutator.lock`)
        .replaceAll(`${CANONICAL_WORKSPACE_DIR}/siss.db`, `${LEGACY_WORKSPACE_DIR}/siss.db`)
        .replaceAll(`${CANONICAL_WORKSPACE_DIR}/skills/`, `${LEGACY_WORKSPACE_DIR}/skills/`)
    : canonicalConfig;

  await mkdir(join(root, LEGACY_WORKSPACE_DIR, "locks"), { recursive: true });
  await mkdir(join(root, LEGACY_WORKSPACE_DIR, "skills"), { recursive: true });
  await Bun.write(legacyConfigPath, legacyConfig);
  await rm(canonicalConfigPath, { force: true });
}

describe("CLI command handlers", () => {
  test("sync zotero imports studies and status reports queue + citekey detail", async () => {
    await withTempRhizome(async (root) => {
      const item: ZoteroItem = {
        key: "ITEM_001",
        version: 42,
        data: {
          itemType: "journalArticle",
          title: "Adaptogen Effects in Athletes",
          creators: [{ creatorType: "author", firstName: "Jane", lastName: "Smith" }],
          date: "2023",
          DOI: "10.1000/example.1",
          collections: ["COLL_A"],
          extra: "PMID: 12345678",
        },
      };

      const syncResult = await runSyncZoteroCommand(
        { full: true, collection: ["Adaptogens"] },
        {
          cwd: root,
          createClient: () => makeFakeClient([item]),
        },
      );

      expect(syncResult.newItems).toBe(1);
      expect(syncResult.updatedItems).toBe(0);

      const overview = await runStatusCommand({ json: true }, { cwd: root });
      expect(overview.mode).toBe("overview");
      expect(overview.overview?.queue["ingest.queued"]).toBe(1);

      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();
      const row = database.db
        .query("SELECT citekey FROM studies LIMIT 1;")
        .get() as { citekey: string };
      database.close();

      const detail = await runStatusCommand({ citekey: row.citekey, json: true }, { cwd: root });
      expect(detail.mode).toBe("study");
      expect(detail.study?.citekey).toBe(row.citekey);
      expect(detail.study?.pipeline_steps.zotero_sync).toBeDefined();
    });
  });

  test("status overview runs via legacy .rhizome config location after canonical config removal", async () => {
    await withTempRhizome(async (root) => {
      const item: ZoteroItem = {
        key: "ITEM_LEGACY_001",
        version: 7,
        data: {
          itemType: "journalArticle",
          title: "Legacy Config Discovery Coverage",
          creators: [{ creatorType: "author", firstName: "Alex", lastName: "Rivera" }],
          date: "2024",
          DOI: "10.1000/example.legacy",
          collections: ["COLL_A"],
        },
      };

      const syncResult = await runSyncZoteroCommand(
        { full: true, collection: ["Adaptogens"] },
        {
          cwd: root,
          createClient: () => makeFakeClient([item]),
        },
      );
      expect(syncResult.newItems).toBe(1);

      await moveConfigToLegacyWorkspace(root);

      const overview = await runStatusCommand({ json: true }, { cwd: root });
      expect(overview.mode).toBe("overview");
      expect(overview.overview?.totals.studies).toBe(1);
    });
  });

  test("lock status and clear --force manage writer lock state", async () => {
    await withTempRhizome(async (root) => {
      const lockPath = join(root, CANONICAL_WORKSPACE_DIR, "locks", "mutator.lock");
      const lock = new WriterLock({ lockPath });
      await lock.acquire("rhizome sync zotero", 4242);

      const active = await runLockStatusCommand({ json: true }, { cwd: root });
      expect(active.active).toBe(true);
      expect(active.metadata?.pid).toBe(4242);

      const cleared = await runLockClearCommand({ force: true, json: true }, { cwd: root });
      expect(cleared.cleared).toBe(true);

      const after = await runLockStatusCommand({ json: true }, { cwd: root });
      expect(after.active).toBe(false);
    });
  });

  test("process --ai runs without errors when no AI jobs are queued", async () => {
    await withTempRhizome(async (root) => {
      const result = await runProcessCommand({ ai: true, batch: 5 }, { cwd: root });

      expect(result.mode).toBe("ai");
      expect(result.result.processed).toBe(0);
      expect(result.result.failed).toBe(0);
    });
  });

  test("process non-AI runs fulltext.marker and still queues summarize when pdf_fetch finds no PDF", async () => {
    await withTempRhizome(async (root) => {
      const item: ZoteroItem = {
        key: "ITEM_NOPDF_001",
        version: 5,
        data: {
          itemType: "journalArticle",
          title: "No PDF continuation",
          creators: [{ creatorType: "author", firstName: "Nora", lastName: "Lane" }],
          date: "2024",
          DOI: "10.1000/example.nopdf",
          collections: ["COLL_A"],
        },
      };

      await runSyncZoteroCommand(
        { full: true, collection: ["Adaptogens"] },
        {
          cwd: root,
          createClient: () => makeFakeClient([item]),
        },
      );

      const result = await runProcessCommand({ ai: false }, { cwd: root });
      expect(result.mode).toBe("non_ai");
      expect(result.result.failed).toBe(0);

      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      const summarizeQueued = database.db
        .query(
          `
          SELECT COUNT(*) AS count
          FROM jobs
          WHERE stage = ? AND status = 'queued';
          `,
        )
        .get(PipelineStep.SUMMARIZE) as { count: number };

      const pdfFetchMetadataRow = database.db
        .query(
          `
          SELECT metadata
          FROM jobs
          WHERE stage = ? AND status = 'complete'
          ORDER BY id DESC
          LIMIT 1;
          `,
        )
        .get(PipelineStep.PDF_FETCH) as { metadata: string } | null;

      const fulltextMarkerMetadataRow = database.db
        .query(
          `
          SELECT metadata
          FROM jobs
          WHERE stage = ? AND status = 'complete'
          ORDER BY id DESC
          LIMIT 1;
          `,
        )
        .get(PipelineStep.FULLTEXT_MARKER) as { metadata: string } | null;

      database.close();

      expect(summarizeQueued.count).toBe(1);
      expect(pdfFetchMetadataRow).toBeDefined();
      expect(fulltextMarkerMetadataRow).toBeDefined();
      const pdfFetchMetadata = JSON.parse(pdfFetchMetadataRow?.metadata ?? "{}") as {
        pdfAvailable?: boolean;
      };
      const fulltextMarkerMetadata = JSON.parse(fulltextMarkerMetadataRow?.metadata ?? "{}") as {
        skipped?: boolean;
        reason?: string;
      };
      expect(pdfFetchMetadata.pdfAvailable).toBe(false);
      expect(fulltextMarkerMetadata.skipped).toBe(true);
      expect(fulltextMarkerMetadata.reason).toBe("no_pdf");
    });
  });

  test("process vault_write maps completed fulltext.marker and pdf_fetch metadata into note frontmatter", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      const sissId = "550e8400-e29b-41d4-a716-446655440020";
      const citekey = "lane2026pdfmeta";
      const pipelineSteps = {
        [PipelineStep.INGEST]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-26T10:00:00.000Z",
          retries: 0,
        },
        [PipelineStep.ZOTERO_SYNC]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-26T10:01:00.000Z",
          retries: 0,
        },
        [PipelineStep.PDF_FETCH]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-26T10:02:00.000Z",
          retries: 0,
        },
      };

      database.db
        .query(
          `
          INSERT INTO studies (siss_id, citekey, source, title, pipeline_overall, pipeline_steps_json, doi)
          VALUES (?, ?, ?, ?, ?, ?, ?);
          `,
        )
        .run(
          sissId,
          citekey,
          "zotero",
          "PDF metadata propagation",
          PipelineOverallStatus.IN_PROGRESS,
          JSON.stringify(pipelineSteps),
          "10.1000/example.meta",
        );

      const pdfRelativePath = "Research/studies/_assets/lane2026pdfmeta/paper.pdf";
      const pdfAbsolutePath = join(vaultPath, pdfRelativePath);
      await mkdir(join(vaultPath, "Research", "studies", "_assets", citekey), { recursive: true });
      await Bun.write(pdfAbsolutePath, "%PDF-1.1\nmeta\n");

      const summaryAbsolutePath = join(vaultPath, "Research", "studies", "_assets", citekey, "summary.current.md");
      await Bun.write(summaryAbsolutePath, "# Summary\n");

      const fulltextAbsolutePath = join(vaultPath, "Research", "studies", "_assets", citekey, "fulltext.md");
      await Bun.write(fulltextAbsolutePath, "---\nnote_type: study_fulltext\n---\n\n# Full text\n");

      database.db
        .query(
          `
          INSERT INTO jobs (siss_id, stage, status, metadata)
          VALUES (?, ?, 'complete', ?), (?, ?, 'complete', ?), (?, ?, 'complete', ?), (?, ?, 'queued', NULL);
          `,
        )
        .run(
          sissId,
          PipelineStep.PDF_FETCH,
          JSON.stringify({
            stage: PipelineStep.PDF_FETCH,
            pdfAvailable: true,
            pdfSource: "unpaywall",
            pdfPath: pdfAbsolutePath,
            attempts: [{ source: "unpaywall", outcome: "success" }],
          }),
          sissId,
          PipelineStep.FULLTEXT_MARKER,
          JSON.stringify({
            stage: PipelineStep.FULLTEXT_MARKER,
            skipped: false,
            fulltextPath: fulltextAbsolutePath,
            provider: "marker",
          }),
          sissId,
          PipelineStep.SUMMARIZE,
          JSON.stringify({ summaryPath: summaryAbsolutePath, source: "abstract_only" }),
          sissId,
          PipelineStep.VAULT_WRITE,
        );

      database.close();

      const result = await runProcessCommand({ ai: false }, { cwd: root });
      expect(result.mode).toBe("non_ai");
      expect(result.result.failed).toBe(0);

      const notePath = join(vaultPath, "Research", "studies", `${citekey}.md`);
      const parsed = matter(await readFile(notePath, "utf8"));
      const frontmatter = parseStudyFrontmatter(parsed.data);

      expect(frontmatter.pdf_available).toBe(true);
      expect(frontmatter.pdf_source).toBe("unpaywall");
      expect(frontmatter.pdf_path).toBe(pdfRelativePath);
      expect(frontmatter.fulltext_path).toBe(
        "Research/studies/_assets/lane2026pdfmeta/fulltext.md",
      );
      expect(frontmatter.summary_path).toBe(
        "Research/studies/_assets/lane2026pdfmeta/summary.current.md",
      );
    });
  });

  test("process vault_write ignores malformed fulltext.marker metadata without crashing", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      const sissId = "550e8400-e29b-41d4-a716-446655440021";
      const citekey = "lane2026fulltextmalformed";
      const pipelineSteps = {
        [PipelineStep.INGEST]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-26T10:00:00.000Z",
          retries: 0,
        },
        [PipelineStep.ZOTERO_SYNC]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-26T10:01:00.000Z",
          retries: 0,
        },
        [PipelineStep.PDF_FETCH]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-26T10:02:00.000Z",
          retries: 0,
        },
      };

      database.db
        .query(
          `
          INSERT INTO studies (siss_id, citekey, source, title, pipeline_overall, pipeline_steps_json, doi)
          VALUES (?, ?, ?, ?, ?, ?, ?);
          `,
        )
        .run(
          sissId,
          citekey,
          "zotero",
          "Malformed fulltext metadata",
          PipelineOverallStatus.IN_PROGRESS,
          JSON.stringify(pipelineSteps),
          "10.1000/example.meta.bad",
        );

      const pdfRelativePath = "Research/studies/_assets/lane2026fulltextmalformed/paper.pdf";
      const pdfAbsolutePath = join(vaultPath, pdfRelativePath);
      await mkdir(join(vaultPath, "Research", "studies", "_assets", citekey), { recursive: true });
      await Bun.write(pdfAbsolutePath, "%PDF-1.1\nbad-meta\n");

      const summaryAbsolutePath = join(vaultPath, "Research", "studies", "_assets", citekey, "summary.current.md");
      await Bun.write(summaryAbsolutePath, "# Summary\n");

      database.db
        .query(
          `
          INSERT INTO jobs (siss_id, stage, status, metadata)
          VALUES (?, ?, 'complete', ?), (?, ?, 'complete', ?), (?, ?, 'complete', ?), (?, ?, 'queued', NULL);
          `,
        )
        .run(
          sissId,
          PipelineStep.PDF_FETCH,
          JSON.stringify({
            stage: PipelineStep.PDF_FETCH,
            pdfAvailable: true,
            pdfSource: "unpaywall",
            pdfPath: pdfAbsolutePath,
            attempts: [{ source: "unpaywall", outcome: "success" }],
          }),
          sissId,
          PipelineStep.FULLTEXT_MARKER,
          "{not-json}",
          sissId,
          PipelineStep.SUMMARIZE,
          JSON.stringify({ summaryPath: summaryAbsolutePath, source: "abstract_only" }),
          sissId,
          PipelineStep.VAULT_WRITE,
        );

      database.close();

      const result = await runProcessCommand({ ai: false }, { cwd: root });
      expect(result.mode).toBe("non_ai");
      expect(result.result.failed).toBe(0);

      const notePath = join(vaultPath, "Research", "studies", `${citekey}.md`);
      const parsed = matter(await readFile(notePath, "utf8"));
      const frontmatter = parseStudyFrontmatter(parsed.data);

      expect(frontmatter.pdf_available).toBe(true);
      expect(frontmatter.pdf_path).toBe(pdfRelativePath);
      expect(frontmatter.fulltext_path).toBeUndefined();
    });
  });

  test("lock status resolves legacy .rhizome workspace config when canonical config is absent", async () => {
    await withTempRhizome(async (root) => {
      await moveConfigToLegacyWorkspace(root, true);

      const status = await runLockStatusCommand({ json: true }, { cwd: root });
      expect(status.lockPath).toBe(join(root, LEGACY_WORKSPACE_DIR, "locks", "mutator.lock"));
      expect(status.active).toBe(false);
    });
  });
});
