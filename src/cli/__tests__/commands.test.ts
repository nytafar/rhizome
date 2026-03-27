import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../db/database";
import { loadConfig } from "../../config/loader";
import { WriterLock } from "../../lock/writer-lock";
import { parseStudyFrontmatter } from "../../schema/frontmatter";
import { PipelineOverallStatus, PipelineStep, PipelineStepStatus } from "../../types/pipeline";
import { runInitCommand } from "../commands/init";
import { runSyncZoteroCommand } from "../commands/sync";
import { runProcessCommand } from "../commands/process";
import { runStatusCommand } from "../commands/status";
import { runRetryCommand } from "../commands/retry";
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

function minuteToClock(minute: number): string {
  const normalized = ((minute % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (normalized % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function buildInactiveUtcWindow(now: Date): string {
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const start = (nowMinutes + 1) % 1440;
  const end = (nowMinutes + 2) % 1440;
  return `${minuteToClock(start)}-${minuteToClock(end)}`;
}

function seedAiSummarizeStudy(params: {
  database: Database;
  rhizomeId: string;
  citekey: string;
  title: string;
  fulltextMetadataRaw?: string;
}): void {
  params.database.db
    .query(
      `
      INSERT INTO studies (rhizome_id, citekey, source, title, pipeline_overall, pipeline_steps_json)
      VALUES (?, ?, ?, ?, ?, ?);
      `,
    )
    .run(
      params.rhizomeId,
      params.citekey,
      "zotero",
      params.title,
      PipelineOverallStatus.IN_PROGRESS,
      "{}",
    );

  if (params.fulltextMetadataRaw) {
    params.database.db
      .query(
        `
        INSERT INTO jobs (rhizome_id, stage, status, metadata)
        VALUES (?, ?, 'complete', ?);
        `,
      )
      .run(params.rhizomeId, PipelineStep.FULLTEXT_MARKER, params.fulltextMetadataRaw);
  }

  params.database.db
    .query(
      `
      INSERT INTO jobs (rhizome_id, stage, status, metadata)
      VALUES (?, ?, 'queued', NULL);
      `,
    )
    .run(params.rhizomeId, PipelineStep.SUMMARIZE);
}

function seedRetryStudy(params: {
  database: Database;
  rhizomeId: string;
  citekey: string;
  title: string;
}): void {
  params.database.db
    .query(
      `
      INSERT INTO studies (rhizome_id, citekey, source, title, pipeline_overall, pipeline_steps_json)
      VALUES (?, ?, ?, ?, ?, ?);
      `,
    )
    .run(
      params.rhizomeId,
      params.citekey,
      "zotero",
      params.title,
      PipelineOverallStatus.NEEDS_ATTENTION,
      "{}",
    );
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

  test("process --ai uses config ai.batch_size when --batch is omitted", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      seedAiSummarizeStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440031",
        citekey: "lane2026configbatcha",
        title: "Config batch A",
      });
      seedAiSummarizeStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440032",
        citekey: "lane2026configbatchb",
        title: "Config batch B",
      });

      database.close();

      const result = await runProcessCommand(
        { ai: true },
        {
          cwd: root,
          loadConfigFn: async (configPath) => {
            const config = await loadConfig(configPath);
            return {
              ...config,
              ai: {
                ...config.ai,
                windows: ["00:00-23:59"],
                timezone: "UTC",
                batch_size: 1,
                cooldown_seconds: 0,
              },
            };
          },
          summarizeStageRunner: async (input) => ({
            summaryPath: join(
              vaultPath,
              "Research",
              "studies",
              "_assets",
              input.study.citekey,
              "summary.current.md",
            ),
            markdown: "# Summary\n",
            output: {
              source: "abstract_only",
              tldr: "TLDR",
              background: "Background",
              methods: "Methods",
              key_findings: "Findings",
              clinical_relevance: "Relevance",
              limitations: "Limitations",
            },
            metadata: {
              stage: PipelineStep.SUMMARIZE,
              durationMs: 1,
              model: "stub-model",
              skillVersion: "v1",
              source: "abstract_only",
              usedFulltext: false,
            },
          }),
        },
      );

      expect(result.mode).toBe("ai");
      expect(result.result.processed).toBe(2);
      expect(result.result.succeeded).toBe(2);

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();
      const remainingQueued = verifyDb.db
        .query(
          `
          SELECT COUNT(*) AS count
          FROM jobs
          WHERE stage = ? AND status = 'queued';
          `,
        )
        .get(PipelineStep.SUMMARIZE) as { count: number };
      verifyDb.close();

      expect(remainingQueued.count).toBe(1);
    });
  });

  test("process --ai uses CLI --batch over config ai.batch_size", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      seedAiSummarizeStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440033",
        citekey: "lane2026clibatcha",
        title: "CLI batch A",
      });
      seedAiSummarizeStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440034",
        citekey: "lane2026clibatchb",
        title: "CLI batch B",
      });

      database.close();

      const result = await runProcessCommand(
        { ai: true, batch: 2 },
        {
          cwd: root,
          loadConfigFn: async (configPath) => {
            const config = await loadConfig(configPath);
            return {
              ...config,
              ai: {
                ...config.ai,
                windows: ["00:00-23:59"],
                timezone: "UTC",
                batch_size: 1,
                cooldown_seconds: 0,
              },
            };
          },
          summarizeStageRunner: async (input) => ({
            summaryPath: join(
              vaultPath,
              "Research",
              "studies",
              "_assets",
              input.study.citekey,
              "summary.current.md",
            ),
            markdown: "# Summary\n",
            output: {
              source: "abstract_only",
              tldr: "TLDR",
              background: "Background",
              methods: "Methods",
              key_findings: "Findings",
              clinical_relevance: "Relevance",
              limitations: "Limitations",
            },
            metadata: {
              stage: PipelineStep.SUMMARIZE,
              durationMs: 1,
              model: "stub-model",
              skillVersion: "v1",
              source: "abstract_only",
              usedFulltext: false,
            },
          }),
        },
      );

      expect(result.mode).toBe("ai");
      expect(result.result.processed).toBe(4);
      expect(result.result.succeeded).toBe(4);

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();
      const remainingQueued = verifyDb.db
        .query(
          `
          SELECT COUNT(*) AS count
          FROM jobs
          WHERE stage = ? AND status = 'queued';
          `,
        )
        .get(PipelineStep.SUMMARIZE) as { count: number };
      verifyDb.close();

      expect(remainingQueued.count).toBe(0);
    });
  });

  test("process --ai holds queued AI jobs when configured window is inactive", async () => {
    await withTempRhizome(async (root) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      seedAiSummarizeStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440035",
        citekey: "lane2026windowhold",
        title: "Window hold",
      });

      database.close();

      const result = await runProcessCommand(
        { ai: true },
        {
          cwd: root,
          loadConfigFn: async (configPath) => {
            const config = await loadConfig(configPath);
            return {
              ...config,
              ai: {
                ...config.ai,
                windows: [buildInactiveUtcWindow(new Date())],
                timezone: "UTC",
                batch_size: 5,
                cooldown_seconds: 0,
              },
            };
          },
        },
      );

      expect(result.mode).toBe("ai");
      expect(result.result.processed).toBe(0);
      expect(result.result.succeeded).toBe(0);

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();
      const queuedSummaries = verifyDb.db
        .query(
          `
          SELECT COUNT(*) AS count
          FROM jobs
          WHERE stage = ? AND status = 'queued';
          `,
        )
        .get(PipelineStep.SUMMARIZE) as { count: number };
      verifyDb.close();

      expect(queuedSummaries.count).toBe(1);
    });
  });

  test("process fails fast when config loader rejects malformed AI config", async () => {
    await withTempRhizome(async (root) => {
      await expect(
        runProcessCommand(
          { ai: true },
          {
            cwd: root,
            loadConfigFn: async () => {
              throw new Error("Invalid config: ai.windows[0] has invalid window format");
            },
          },
        ),
      ).rejects.toThrow("Invalid config: ai.windows[0] has invalid window format");
    });
  });

  test("process --ai surfaces invalid AI timezone during AI pass after non-AI pre-pass", async () => {
    await withTempRhizome(async (root) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      const rhizomeId = "550e8400-e29b-41d4-a716-446655440036";
      database.db
        .query(
          `
          INSERT INTO studies (rhizome_id, citekey, source, title, pipeline_overall, pipeline_steps_json)
          VALUES (?, ?, ?, ?, ?, ?);
          `,
        )
        .run(
          rhizomeId,
          "lane2026invalidtimezone",
          "zotero",
          "Invalid timezone",
          PipelineOverallStatus.NOT_STARTED,
          "{}",
        );

      database.db
        .query(
          `
          INSERT INTO jobs (rhizome_id, stage, status, metadata)
          VALUES (?, ?, 'queued', NULL), (?, ?, 'queued', NULL);
          `,
        )
        .run(rhizomeId, PipelineStep.INGEST, rhizomeId, PipelineStep.SUMMARIZE);

      database.close();

      await expect(
        runProcessCommand(
          { ai: true },
          {
            cwd: root,
            loadConfigFn: async (configPath) => {
              const config = await loadConfig(configPath);
              return {
                ...config,
                ai: {
                  ...config.ai,
                  windows: ["00:00-23:59"],
                  timezone: "Mars/Phobos",
                  batch_size: 5,
                  cooldown_seconds: 0,
                },
              };
            },
          },
        ),
      ).rejects.toThrow("Invalid AI window configuration");

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();

      const ingestComplete = verifyDb.db
        .query(
          `
          SELECT COUNT(*) AS count
          FROM jobs
          WHERE stage = ? AND status = 'complete';
          `,
        )
        .get(PipelineStep.INGEST) as { count: number };

      const summarizeQueued = verifyDb.db
        .query(
          `
          SELECT COUNT(*) AS count
          FROM jobs
          WHERE stage = ? AND status = 'queued';
          `,
        )
        .get(PipelineStep.SUMMARIZE) as { count: number };

      verifyDb.close();

      expect(ingestComplete.count).toBe(1);
      expect(summarizeQueued.count).toBe(1);
    });
  });

  test("process summarize loads fulltext markdown when fulltext.marker metadata points to readable vault content", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      const rhizomeId = "550e8400-e29b-41d4-a716-446655440022";
      const citekey = "lane2026fulltextinput";
      const fulltextPath = join(vaultPath, "Research", "studies", "_assets", citekey, "fulltext.md");
      await mkdir(join(vaultPath, "Research", "studies", "_assets", citekey), { recursive: true });
      await Bun.write(fulltextPath, "# Full Text\n\nDetailed markdown body.");

      seedAiSummarizeStudy({
        database,
        rhizomeId,
        citekey,
        title: "Fulltext summarize handoff",
        fulltextMetadataRaw: JSON.stringify({ fulltextPath }),
      });

      database.close();

      let capturedFulltextMarkdown: string | undefined;

      const result = await runProcessCommand(
        { ai: true, batch: 5 },
        {
          cwd: root,
          loadConfigFn: async (configPath) => {
            const config = await loadConfig(configPath);
            return {
              ...config,
              ai: {
                ...config.ai,
                windows: ["00:00-23:59"],
                timezone: "UTC",
                cooldown_seconds: 0,
              },
            };
          },
          summarizeStageRunner: async (input) => {
            capturedFulltextMarkdown = input.fulltextMarkdown;
            return {
              summaryPath: join(vaultPath, "Research", "studies", "_assets", citekey, "summary.current.md"),
              markdown: "# Summary\n",
              output: {
                source: "fulltext",
                tldr: "TLDR",
                background: "Background",
                methods: "Methods",
                key_findings: "Findings",
                clinical_relevance: "Relevance",
                limitations: "Limitations",
              },
              metadata: {
                stage: PipelineStep.SUMMARIZE,
                durationMs: 1,
                model: "stub-model",
                skillVersion: "v1",
                source: "fulltext",
                usedFulltext: true,
              },
            };
          },
        },
      );

      expect(result.mode).toBe("ai");
      expect(result.result.failed).toBe(0);
      expect(capturedFulltextMarkdown).toContain("Detailed markdown body.");
    });
  });

  test("process summarize falls back when fulltext.marker metadata is malformed", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      const rhizomeId = "550e8400-e29b-41d4-a716-446655440023";
      const citekey = "lane2026malformedfulltextjson";

      seedAiSummarizeStudy({
        database,
        rhizomeId,
        citekey,
        title: "Malformed fulltext metadata fallback",
        fulltextMetadataRaw: "{not-json}",
      });

      database.close();

      let capturedFulltextMarkdown: string | undefined;

      const result = await runProcessCommand(
        { ai: true, batch: 5 },
        {
          cwd: root,
          loadConfigFn: async (configPath) => {
            const config = await loadConfig(configPath);
            return {
              ...config,
              ai: {
                ...config.ai,
                windows: ["00:00-23:59"],
                timezone: "UTC",
                cooldown_seconds: 0,
              },
            };
          },
          summarizeStageRunner: async (input) => {
            capturedFulltextMarkdown = input.fulltextMarkdown;
            return {
              summaryPath: join(vaultPath, "Research", "studies", "_assets", citekey, "summary.current.md"),
              markdown: "# Summary\n",
              output: {
                source: "abstract_only",
                tldr: "TLDR",
                background: "Background",
                methods: "Methods",
                key_findings: "Findings",
                clinical_relevance: "Relevance",
                limitations: "Limitations",
              },
              metadata: {
                stage: PipelineStep.SUMMARIZE,
                durationMs: 1,
                model: "stub-model",
                skillVersion: "v1",
                source: "abstract_only",
                usedFulltext: false,
              },
            };
          },
        },
      );

      expect(result.mode).toBe("ai");
      expect(result.result.failed).toBe(0);
      expect(capturedFulltextMarkdown).toBeUndefined();
    });
  });

  test("process summarize falls back when fulltext path is outside vault or markdown is missing/empty", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const scenarios = [
        {
          rhizomeId: "550e8400-e29b-41d4-a716-446655440024",
          citekey: "lane2026outofrootfulltext",
          title: "Out of root fallback",
          fulltextPath: join(root, "outside-vault.md"),
          markdown: "# Should not be read\n",
        },
        {
          rhizomeId: "550e8400-e29b-41d4-a716-446655440025",
          citekey: "lane2026missingfulltext",
          title: "Missing file fallback",
          fulltextPath: join(vaultPath, "Research", "studies", "_assets", "lane2026missingfulltext", "missing.md"),
          markdown: undefined,
        },
        {
          rhizomeId: "550e8400-e29b-41d4-a716-446655440026",
          citekey: "lane2026emptyfulltext",
          title: "Empty markdown fallback",
          fulltextPath: join(vaultPath, "Research", "studies", "_assets", "lane2026emptyfulltext", "fulltext.md"),
          markdown: "   \n\n\t",
        },
      ];

      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      for (const scenario of scenarios) {
        if (typeof scenario.markdown === "string") {
          await mkdir(join(vaultPath, "Research", "studies", "_assets", scenario.citekey), {
            recursive: true,
          });
          await Bun.write(scenario.fulltextPath, scenario.markdown);
        }

        seedAiSummarizeStudy({
          database,
          rhizomeId: scenario.rhizomeId,
          citekey: scenario.citekey,
          title: scenario.title,
          fulltextMetadataRaw: JSON.stringify({ fulltextPath: scenario.fulltextPath }),
        });
      }

      database.close();

      const capturedByCitekey = new Map<string, string | undefined>();

      const result = await runProcessCommand(
        { ai: true, batch: 10 },
        {
          cwd: root,
          loadConfigFn: async (configPath) => {
            const config = await loadConfig(configPath);
            return {
              ...config,
              ai: {
                ...config.ai,
                windows: ["00:00-23:59"],
                timezone: "UTC",
                cooldown_seconds: 0,
              },
            };
          },
          summarizeStageRunner: async (input) => {
            capturedByCitekey.set(input.study.citekey, input.fulltextMarkdown);
            return {
              summaryPath: join(
                vaultPath,
                "Research",
                "studies",
                "_assets",
                input.study.citekey,
                "summary.current.md",
              ),
              markdown: "# Summary\n",
              output: {
                source: "abstract_only",
                tldr: "TLDR",
                background: "Background",
                methods: "Methods",
                key_findings: "Findings",
                clinical_relevance: "Relevance",
                limitations: "Limitations",
              },
              metadata: {
                stage: PipelineStep.SUMMARIZE,
                durationMs: 1,
                model: "stub-model",
                skillVersion: "v1",
                source: "abstract_only",
                usedFulltext: false,
              },
            };
          },
        },
      );

      expect(result.mode).toBe("ai");
      expect(result.result.failed).toBe(0);
      expect(capturedByCitekey.get("lane2026outofrootfulltext")).toBeUndefined();
      expect(capturedByCitekey.get("lane2026missingfulltext")).toBeUndefined();
      expect(capturedByCitekey.get("lane2026emptyfulltext")).toBeUndefined();
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

      const fulltextMarkerComplete = database.db
        .query(
          `
          SELECT COUNT(*) AS count
          FROM jobs
          WHERE stage = ? AND status = 'complete';
          `,
        )
        .get(PipelineStep.FULLTEXT_MARKER) as { count: number };

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
      expect(fulltextMarkerComplete.count).toBe(1);
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

      const rhizomeId = "550e8400-e29b-41d4-a716-446655440020";
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
          INSERT INTO studies (rhizome_id, citekey, source, title, pipeline_overall, pipeline_steps_json, doi)
          VALUES (?, ?, ?, ?, ?, ?, ?);
          `,
        )
        .run(
          rhizomeId,
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
          INSERT INTO jobs (rhizome_id, stage, status, metadata)
          VALUES (?, ?, 'complete', ?), (?, ?, 'complete', ?), (?, ?, 'complete', ?), (?, ?, 'queued', NULL);
          `,
        )
        .run(
          rhizomeId,
          PipelineStep.PDF_FETCH,
          JSON.stringify({
            stage: PipelineStep.PDF_FETCH,
            pdfAvailable: true,
            pdfSource: "unpaywall",
            pdfPath: pdfAbsolutePath,
            attempts: [{ source: "unpaywall", outcome: "success" }],
          }),
          rhizomeId,
          PipelineStep.FULLTEXT_MARKER,
          JSON.stringify({
            stage: PipelineStep.FULLTEXT_MARKER,
            skipped: false,
            fulltextPath: fulltextAbsolutePath,
            provider: "marker",
          }),
          rhizomeId,
          PipelineStep.SUMMARIZE,
          JSON.stringify({ summaryPath: summaryAbsolutePath, source: "abstract_only" }),
          rhizomeId,
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
      expect(frontmatter.pdf).toBe(`[[${pdfRelativePath}|PDF]]`);
      expect(frontmatter.fulltext).toBe(
        "[[Research/studies/_assets/lane2026pdfmeta/fulltext.md|Full Text]]",
      );
      expect(frontmatter.summary).toBe(
        "[[Research/studies/_assets/lane2026pdfmeta/summary.current.md|AI Summary]]",
      );
    });
  });

  test("process vault_write ignores malformed fulltext.marker metadata without crashing", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      const rhizomeId = "550e8400-e29b-41d4-a716-446655440021";
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
          INSERT INTO studies (rhizome_id, citekey, source, title, pipeline_overall, pipeline_steps_json, doi)
          VALUES (?, ?, ?, ?, ?, ?, ?);
          `,
        )
        .run(
          rhizomeId,
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
          INSERT INTO jobs (rhizome_id, stage, status, metadata)
          VALUES (?, ?, 'complete', ?), (?, ?, 'complete', ?), (?, ?, 'complete', ?), (?, ?, 'queued', NULL);
          `,
        )
        .run(
          rhizomeId,
          PipelineStep.PDF_FETCH,
          JSON.stringify({
            stage: PipelineStep.PDF_FETCH,
            pdfAvailable: true,
            pdfSource: "unpaywall",
            pdfPath: pdfAbsolutePath,
            attempts: [{ source: "unpaywall", outcome: "success" }],
          }),
          rhizomeId,
          PipelineStep.FULLTEXT_MARKER,
          "{not-json}",
          rhizomeId,
          PipelineStep.SUMMARIZE,
          JSON.stringify({ summaryPath: summaryAbsolutePath, source: "abstract_only" }),
          rhizomeId,
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
      expect(frontmatter.pdf).toBe(`[[${pdfRelativePath}|PDF]]`);
      expect(frontmatter.fulltext).toBeUndefined();
    });
  });

  test("retry --citekey requeues only that study and preserves retry_count by default", async () => {
    await withTempRhizome(async (root) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      seedRetryStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440101",
        citekey: "lane2026retrytarget",
        title: "Retry target",
      });
      seedRetryStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440102",
        citekey: "lane2026retryother",
        title: "Retry other",
      });

      database.db
        .query(
          `
          INSERT INTO jobs (rhizome_id, stage, status, retry_count, error_message, error_class, metadata)
          VALUES
            (?, ?, 'error', 2, 'temporary outage', 'transient', ?),
            (?, ?, 'paused', 1, 'manual pause', 'permanent', ?),
            (?, ?, 'error', 4, 'other failure', 'transient', ?);
          `,
        )
        .run(
          "550e8400-e29b-41d4-a716-446655440101",
          PipelineStep.SUMMARIZE,
          JSON.stringify({ next_attempt_at: "2099-01-01T00:00:00.000Z", pause_reason: "max_retries_exhausted" }),
          "550e8400-e29b-41d4-a716-446655440101",
          PipelineStep.VAULT_WRITE,
          JSON.stringify({ pause_reason: "max_retries_exhausted", last_error: "manual pause" }),
          "550e8400-e29b-41d4-a716-446655440102",
          PipelineStep.PDF_FETCH,
          JSON.stringify({ next_attempt_at: "2099-01-01T00:00:00.000Z" }),
        );

      database.close();

      const result = await runRetryCommand({ citekey: "lane2026retrytarget", json: true }, { cwd: root });
      expect(result.selector.mode).toBe("citekey");
      expect(result.studiesMatched).toBe(1);
      expect(result.jobsRetried).toBe(2);
      expect(result.retriedByStatus.error).toBe(1);
      expect(result.retriedByStatus.paused).toBe(1);
      expect(result.resetRetries).toBe(false);

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();

      const targetJobs = verifyDb.db
        .query(
          `
          SELECT status, retry_count, error_message, error_class, metadata
          FROM jobs
          WHERE rhizome_id = ?
          ORDER BY id ASC;
          `,
        )
        .all("550e8400-e29b-41d4-a716-446655440101") as Array<{
        status: string;
        retry_count: number;
        error_message: string | null;
        error_class: string | null;
        metadata: string | null;
      }>;

      const otherJob = verifyDb.db
        .query(
          `
          SELECT status, retry_count
          FROM jobs
          WHERE rhizome_id = ?
          LIMIT 1;
          `,
        )
        .get("550e8400-e29b-41d4-a716-446655440102") as { status: string; retry_count: number };

      verifyDb.close();

      expect(targetJobs.map((job) => job.status)).toEqual(["queued", "queued"]);
      expect(targetJobs.map((job) => job.retry_count)).toEqual([2, 1]);
      expect(targetJobs.every((job) => job.error_message === null && job.error_class === null)).toBe(true);
      expect(JSON.parse(targetJobs[0]?.metadata ?? "{}").next_attempt_at).toBeUndefined();
      expect(JSON.parse(targetJobs[1]?.metadata ?? "{}").pause_reason).toBeUndefined();

      expect(otherJob.status).toBe("error");
      expect(otherJob.retry_count).toBe(4);

      const statusOverview = await runStatusCommand({ json: true }, { cwd: root });
      expect(statusOverview.mode).toBe("overview");
      expect(statusOverview.overview?.queue["pdf_fetch.error"]).toBe(1);
      expect(statusOverview.overview?.queue["summarize.queued"]).toBe(1);
      expect(statusOverview.overview?.queue["vault_write.queued"]).toBe(1);
    });
  });

  test("retry --all-failed requeues all error/paused jobs and --reset-retries zeros retry_count", async () => {
    await withTempRhizome(async (root) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      seedRetryStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440103",
        citekey: "lane2026retrybulk1",
        title: "Retry bulk one",
      });
      seedRetryStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440104",
        citekey: "lane2026retrybulk2",
        title: "Retry bulk two",
      });

      database.db
        .query(
          `
          INSERT INTO jobs (rhizome_id, stage, status, retry_count, metadata)
          VALUES
            (?, ?, 'error', 3, ?),
            (?, ?, 'paused', 2, ?),
            (?, ?, 'queued', 9, NULL);
          `,
        )
        .run(
          "550e8400-e29b-41d4-a716-446655440103",
          PipelineStep.SUMMARIZE,
          JSON.stringify({ next_attempt_at: "2099-01-01T00:00:00.000Z" }),
          "550e8400-e29b-41d4-a716-446655440104",
          PipelineStep.PDF_FETCH,
          JSON.stringify({ pause_reason: "manual" }),
          "550e8400-e29b-41d4-a716-446655440104",
          PipelineStep.VAULT_WRITE,
        );

      database.close();

      const result = await runRetryCommand(
        { allFailed: true, resetRetries: true, json: true },
        { cwd: root },
      );

      expect(result.selector.mode).toBe("all_failed");
      expect(result.studiesMatched).toBe(2);
      expect(result.jobsRetried).toBe(2);
      expect(result.retriedByStatus.error).toBe(1);
      expect(result.retriedByStatus.paused).toBe(1);
      expect(result.resetRetries).toBe(true);

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();

      const retriedJobs = verifyDb.db
        .query(
          `
          SELECT status, retry_count
          FROM jobs
          WHERE stage IN (?, ?)
          ORDER BY id ASC;
          `,
        )
        .all(PipelineStep.SUMMARIZE, PipelineStep.PDF_FETCH) as Array<{
        status: string;
        retry_count: number;
      }>;

      const unaffected = verifyDb.db
        .query(
          `
          SELECT status, retry_count
          FROM jobs
          WHERE stage = ?
          LIMIT 1;
          `,
        )
        .get(PipelineStep.VAULT_WRITE) as { status: string; retry_count: number };

      verifyDb.close();

      expect(retriedJobs).toEqual([
        { status: "queued", retry_count: 0 },
        { status: "queued", retry_count: 0 },
      ]);
      expect(unaffected).toEqual({ status: "queued", retry_count: 9 });

      const statusOverview = await runStatusCommand({ json: true }, { cwd: root });
      expect(statusOverview.mode).toBe("overview");
      expect(statusOverview.overview?.queue["summarize.queued"]).toBe(1);
      expect(statusOverview.overview?.queue["pdf_fetch.queued"]).toBe(1);
      expect(statusOverview.overview?.queue["vault_write.queued"]).toBe(1);
    });
  });

  test("retry rejects invalid selector combinations and malformed citekey input", async () => {
    await withTempRhizome(async (root) => {
      await expect(runRetryCommand({}, { cwd: root })).rejects.toThrow(
        "Select exactly one retry target: use either --citekey <key> or --all-failed",
      );

      await expect(runRetryCommand({ citekey: "lane2026x", allFailed: true }, { cwd: root })).rejects.toThrow(
        "Select exactly one retry target: use either --citekey <key> or --all-failed",
      );

      await expect(runRetryCommand({ citekey: "   " }, { cwd: root })).rejects.toThrow(
        "--citekey requires a non-empty value",
      );
    });
  });

  test("retry --citekey errors for unknown study selector", async () => {
    await withTempRhizome(async (root) => {
      await expect(runRetryCommand({ citekey: "lane2026missingstudy" }, { cwd: root })).rejects.toThrow(
        "Study not found for citekey=lane2026missingstudy",
      );
    });
  });

  test("retry --all-failed is an explicit no-op when no failed/paused jobs exist", async () => {
    await withTempRhizome(async (root) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      seedRetryStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440105",
        citekey: "lane2026retrynoop",
        title: "Retry no-op",
      });

      database.db
        .query(
          `
          INSERT INTO jobs (rhizome_id, stage, status, retry_count, metadata)
          VALUES (?, ?, 'queued', 7, NULL);
          `,
        )
        .run("550e8400-e29b-41d4-a716-446655440105", PipelineStep.SUMMARIZE);

      database.close();

      const result = await runRetryCommand({ allFailed: true, json: true }, { cwd: root });
      expect(result.studiesMatched).toBe(0);
      expect(result.jobsRetried).toBe(0);
      expect(result.retriedByStatus).toEqual({ error: 0, paused: 0 });

      const statusOverview = await runStatusCommand({ json: true }, { cwd: root });
      expect(statusOverview.mode).toBe("overview");
      expect(statusOverview.overview?.queue["summarize.queued"]).toBe(1);
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
