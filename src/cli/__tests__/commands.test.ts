import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { runReprocessCommand } from "../commands/reprocess";
import { runAuditCommand } from "../commands/audit";
import { runLockClearCommand, runLockStatusCommand } from "../commands/lock";
import {
  runTaxonomyApproveCommand,
  runTaxonomyApplyCommand,
  runTaxonomyRejectCommand,
  runTaxonomyReviewCommand,
} from "../commands/taxonomy";
import { createCliProgram } from "../index";
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

function buildStubClassifyResult(citekey: string, vaultPath: string) {
  const tier4 = {
    study_type: null,
    sample_size: null,
    duration_weeks: null,
    population: null,
    control: null,
    blinding: null,
    primary_outcome: null,
    outcome_direction: null,
    effect_size: null,
    significance: null,
    evidence_quality: null,
    funding_source: null,
    conflict_of_interest: null,
  } as const;

  const tier5 = {
    herb_species: [],
    common_names: [],
    active_compounds: [],
    plant_parts: [],
    extraction_types: [],
    dosages: [],
    adverse_events: [],
    safety_rating: null,
  } as const;

  const tier6 = {
    therapeutic_areas: [],
    mechanisms: [],
    indications: [],
    contraindications: [],
    drug_interactions: [],
    research_gaps: [],
  } as const;

  return {
    summaryPath: join(vaultPath, "Research", "studies", "_assets", citekey, "summary.current.md"),
    output: {
      source: "abstract_only" as const,
      tier_4: tier4,
      tier_5: tier5,
      tier_6_taxonomy: tier6,
      tier_7_provisional: [],
    },
    metadata: {
      stage: PipelineStep.CLASSIFY,
      durationMs: 1,
      model: "stub-model",
      skillVersion: "v1",
      generatedAt: "2026-03-27T00:00:00.000Z",
      source: "abstract_only" as const,
      provisionalCount: 0,
      provisional: [],
      tier_4: tier4,
      tier_5: tier5,
      tier_6_taxonomy: tier6,
      tier_7_provisional: [],
    },
  };
}

function buildStubClassifyResultWithProvisional(
  citekey: string,
  vaultPath: string,
  tier7Provisional: Array<{ group: string; value: string; confidence: number }>,
) {
  const base = buildStubClassifyResult(citekey, vaultPath);
  return {
    ...base,
    output: {
      ...base.output,
      tier_7_provisional: tier7Provisional,
    },
    metadata: {
      ...base.metadata,
      provisionalCount: tier7Provisional.length,
      provisional: tier7Provisional,
      tier_7_provisional: tier7Provisional,
    },
  };
}

function makeTaxonomyPath(vaultPath: string): string {
  return join(vaultPath, "Research", "_system", "taxonomy.json");
}

async function writeTaxonomyFixture(params: {
  vaultPath: string;
  therapeuticPending?: Record<string, { count: number }>;
  mechanismPending?: Record<string, { count: number }>;
}): Promise<void> {
  const therapeuticPending = params.therapeuticPending ?? {};
  const mechanismPending = params.mechanismPending ?? {};

  const makePending = (count: number) => ({
    count,
    first_seen_at: "2026-03-27T00:00:00.000Z",
    last_seen_at: "2026-03-27T00:00:00.000Z",
    sources: ["classifier"],
  });

  await mkdir(join(params.vaultPath, "Research", "_system"), { recursive: true });
  await writeFile(
    makeTaxonomyPath(params.vaultPath),
    JSON.stringify(
      {
        version: 1,
        groups: {
          therapeutic_areas: {
            values: {},
            pending: Object.fromEntries(
              Object.entries(therapeuticPending).map(([value, entry]) => [value, makePending(entry.count)]),
            ),
          },
          mechanisms: {
            values: {},
            pending: Object.fromEntries(
              Object.entries(mechanismPending).map(([value, entry]) => [value, makePending(entry.count)]),
            ),
          },
          indications: { values: {}, pending: {} },
          contraindications: { values: {}, pending: {} },
          drug_interactions: { values: {}, pending: {} },
          research_gaps: { values: {}, pending: {} },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
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

function seedPipelineRun(params: {
  database: Database;
  rhizomeId: string;
  runId: string;
  step: PipelineStep;
  status: "started" | "completed" | "failed" | "skipped";
  retries?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  skipReason?: string | null;
  error?: string | null;
  model?: string | null;
  skill?: string | null;
}): void {
  params.database.db
    .query(
      `
      INSERT INTO pipeline_runs (
        rhizome_id,
        run_id,
        step,
        status,
        started_at,
        completed_at,
        retries,
        skip_reason,
        error,
        model,
        skill
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
    )
    .run(
      params.rhizomeId,
      params.runId,
      params.step,
      params.status,
      params.startedAt ?? null,
      params.completedAt ?? null,
      params.retries ?? 0,
      params.skipReason ?? null,
      params.error ?? null,
      params.model ?? null,
      params.skill ?? null,
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
          classifyStageRunner: async (input) => buildStubClassifyResult(input.study.citekey, vaultPath),
        },
      );

      expect(result.mode).toBe("ai");
      expect(result.result.processed).toBe(1);
      expect(result.result.succeeded).toBe(1);

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
          classifyStageRunner: async (input) => buildStubClassifyResult(input.study.citekey, vaultPath),
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

      expect(remainingQueued.count).toBe(0);
    });
  });

  test("process --ai persists classify provisional boundaries (empty vs multiple new:) into metadata and frontmatter", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      seedAiSummarizeStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440037",
        citekey: "lane2026provempty",
        title: "Provisional empty",
      });
      seedAiSummarizeStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440038",
        citekey: "lane2026provmulti",
        title: "Provisional multiple",
      });

      database.close();

      const result = await runProcessCommand(
        { ai: true, batch: 4 },
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
                batch_size: 2,
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
          classifyStageRunner: async (input) =>
            input.study.citekey === "lane2026provmulti"
              ? buildStubClassifyResultWithProvisional(input.study.citekey, vaultPath, [
                  { group: "mechanisms", value: "new:hpa_axis_resilience", confidence: 0.73 },
                  { group: "therapeutic_areas", value: "new:stress_recovery", confidence: 0.66 },
                ])
              : buildStubClassifyResult(input.study.citekey, vaultPath),
        },
      );

      expect(result.mode).toBe("ai");
      expect(result.result.processed).toBe(6);
      expect(result.result.failed).toBe(0);

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();

      const classifyRows = verifyDb.db
        .query(
          `
          SELECT s.citekey AS citekey, j.metadata AS metadata
          FROM jobs j
          INNER JOIN studies s ON s.rhizome_id = j.rhizome_id
          WHERE j.stage = ? AND j.status = 'complete'
          ORDER BY s.citekey ASC;
          `,
        )
        .all(PipelineStep.CLASSIFY) as Array<{ citekey: string; metadata: string }>;

      verifyDb.close();

      const metadataByCitekey = new Map(
        classifyRows.map((row) => [row.citekey, JSON.parse(row.metadata) as Record<string, unknown>]),
      );

      const emptyMetadata = metadataByCitekey.get("lane2026provempty");
      const multiMetadata = metadataByCitekey.get("lane2026provmulti");

      expect(emptyMetadata?.provisional_count).toBe(0);
      expect(emptyMetadata?.tier_7_provisional).toEqual([]);
      expect(multiMetadata?.provisional_count).toBe(2);
      expect((multiMetadata?.tier_7_provisional as unknown[] | undefined)?.length).toBe(2);

      const emptyNotePath = join(vaultPath, "Research", "studies", "lane2026provempty.md");
      const multiNotePath = join(vaultPath, "Research", "studies", "lane2026provmulti.md");

      const emptyFrontmatter = parseStudyFrontmatter(matter(await readFile(emptyNotePath, "utf8")).data);
      const multiFrontmatter = parseStudyFrontmatter(matter(await readFile(multiNotePath, "utf8")).data);

      expect(emptyFrontmatter.has_classification).toBe(true);
      expect(emptyFrontmatter.tier_7_provisional).toEqual([]);
      expect(emptyFrontmatter.taxonomy_provisional).toBeUndefined();

      expect(multiFrontmatter.has_classification).toBe(true);
      expect(multiFrontmatter.tier_7_provisional?.map((entry) => entry.value)).toEqual([
        "new:hpa_axis_resilience",
        "new:stress_recovery",
      ]);
    });
  });

  test("process --ai mutates taxonomy usage, dedupes pending, and auto-promotes at threshold", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      seedAiSummarizeStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440040",
        citekey: "lane2026taxonomyfirst",
        title: "Taxonomy first pass",
      });
      seedAiSummarizeStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440041",
        citekey: "lane2026taxonomysecond",
        title: "Taxonomy second pass",
      });

      database.close();

      const classifyPayload = {
        therapeutic_areas: ["stress_support"],
        mechanisms: ["cortisol_modulation"],
        indications: [],
        contraindications: [],
        drug_interactions: [],
        research_gaps: [],
      } as const;

      const processDeps = {
        cwd: root,
        loadConfigFn: async (configPath: string) => {
          const config = await loadConfig(configPath);
          return {
            ...config,
            ai: {
              ...config.ai,
              windows: ["00:00-23:59"],
              timezone: "UTC",
              batch_size: 2,
              cooldown_seconds: 0,
            },
            taxonomy: {
              ...config.taxonomy,
              auto_promote_threshold: 2,
            },
          };
        },
        summarizeStageRunner: async (input: { study: { citekey: string } }) => ({
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
            source: "abstract_only" as const,
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
            source: "abstract_only" as const,
            usedFulltext: false,
          },
        }),
        classifyStageRunner: async (input: { study: { citekey: string } }) => {
          const base = buildStubClassifyResultWithProvisional(input.study.citekey, vaultPath, [
            { group: "mechanisms", value: "new:hpa_axis_resilience", confidence: 0.76 },
            { group: "mechanisms", value: "new:hpa_axis_resilience", confidence: 0.74 },
          ]);

          return {
            ...base,
            output: {
              ...base.output,
              tier_6_taxonomy: classifyPayload,
            },
            metadata: {
              ...base.metadata,
              tier_6_taxonomy: classifyPayload,
            },
          };
        },
      };

      const firstResult = await runProcessCommand({ ai: true, batch: 2 }, processDeps);
      const secondResult = await runProcessCommand({ ai: true, batch: 2 }, processDeps);

      expect(firstResult.mode).toBe("ai");
      expect(secondResult.mode).toBe("ai");
      expect(firstResult.result.failed).toBe(0);
      expect(secondResult.result.failed).toBe(0);

      const taxonomyPath = makeTaxonomyPath(vaultPath);
      const taxonomyRaw = await readFile(taxonomyPath, "utf8");
      const taxonomy = JSON.parse(taxonomyRaw) as {
        groups: {
          therapeutic_areas: { values: Record<string, { count: number }> };
          mechanisms: {
            values: Record<string, { count: number; promoted_at?: string; promoted_sources?: string[] }>;
            pending: Record<string, { count: number }>;
          };
        };
      };

      expect(taxonomy.groups.therapeutic_areas.values.stress_support.count).toBe(2);
      expect(taxonomy.groups.mechanisms.values.cortisol_modulation.count).toBe(2);
      expect(taxonomy.groups.mechanisms.pending.hpa_axis_resilience).toBeUndefined();
      expect(taxonomy.groups.mechanisms.values.hpa_axis_resilience.count).toBe(4);
      expect(taxonomy.groups.mechanisms.values.hpa_axis_resilience.promoted_at).toBeDefined();
      expect(taxonomy.groups.mechanisms.values.hpa_axis_resilience.promoted_sources).toEqual([
        "classifier",
      ]);

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();

      const classifyRows = verifyDb.db
        .query(
          `
          SELECT metadata
          FROM jobs
          WHERE stage = ? AND status = 'complete'
          ORDER BY id ASC;
          `,
        )
        .all(PipelineStep.CLASSIFY) as Array<{ metadata: string }>;

      verifyDb.close();

      expect(classifyRows).toHaveLength(2);
      for (const row of classifyRows) {
        const metadata = JSON.parse(row.metadata) as {
          taxonomy_usage_updates?: number;
          taxonomy_pending_updates?: number;
          taxonomy_promotions?: unknown[];
        };
        expect(metadata.taxonomy_usage_updates).toBe(2);
        expect(metadata.taxonomy_pending_updates).toBe(2);
        expect(Array.isArray(metadata.taxonomy_promotions)).toBe(true);
      }
    });
  });

  test("process --ai fails classify stage when taxonomy file is malformed before mutation", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      const rhizomeId = "550e8400-e29b-41d4-a716-446655440042";
      seedAiSummarizeStudy({
        database,
        rhizomeId,
        citekey: "lane2026taxonomymalformedfile",
        title: "Malformed taxonomy file",
      });
      database.close();

      await mkdir(join(vaultPath, "Research", "_system"), { recursive: true });
      await writeFile(makeTaxonomyPath(vaultPath), "{bad-json", "utf8");

      const processDeps = {
        cwd: root,
        loadConfigFn: async (configPath: string) => {
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
        summarizeStageRunner: async (input: { study: { citekey: string } }) => ({
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
            source: "abstract_only" as const,
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
            source: "abstract_only" as const,
            usedFulltext: false,
          },
        }),
        classifyStageRunner: async (input: { study: { citekey: string } }) =>
          buildStubClassifyResultWithProvisional(input.study.citekey, vaultPath, [
            { group: "mechanisms", value: "new:hpa_axis_resilience", confidence: 0.76 },
          ]),
      };

      const firstResult = await runProcessCommand({ ai: true, batch: 1 }, processDeps);
      const secondResult = await runProcessCommand({ ai: true, batch: 1 }, processDeps);

      expect(firstResult.mode).toBe("ai");
      expect(secondResult.mode).toBe("ai");
      expect(secondResult.result.failed).toBe(1);

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();

      const classifyJob = verifyDb.db
        .query(
          `
          SELECT status, error_class, error_message
          FROM jobs
          WHERE rhizome_id = ? AND stage = ?
          ORDER BY id DESC
          LIMIT 1;
          `,
        )
        .get(rhizomeId, PipelineStep.CLASSIFY) as {
        status: string;
        error_class: string | null;
        error_message: string | null;
      };

      verifyDb.close();

      expect(classifyJob.status).toBe("paused");
      expect(classifyJob.error_class).toBe("permanent");
      expect(classifyJob.error_message).toContain("[taxonomy:parse]");
    });
  });

  test("process --ai fails classify stage on malformed provisional entries", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      const rhizomeId = "550e8400-e29b-41d4-a716-446655440043";
      seedAiSummarizeStudy({
        database,
        rhizomeId,
        citekey: "lane2026taxonomybadprovisional",
        title: "Malformed provisional output",
      });
      database.close();

      const processDeps = {
        cwd: root,
        loadConfigFn: async (configPath: string) => {
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
        summarizeStageRunner: async (input: { study: { citekey: string } }) => ({
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
            source: "abstract_only" as const,
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
            source: "abstract_only" as const,
            usedFulltext: false,
          },
        }),
        classifyStageRunner: async (input: { study: { citekey: string } }) => {
          const base = buildStubClassifyResult(input.study.citekey, vaultPath);
          return {
            ...base,
            output: {
              ...base.output,
              tier_7_provisional: [
                {
                  group: "mechanisms",
                  value: "not-new-format",
                  confidence: 0.5,
                },
              ],
            },
            metadata: {
              ...base.metadata,
              provisionalCount: 1,
              provisional: [
                {
                  group: "mechanisms",
                  value: "not-new-format",
                  confidence: 0.5,
                },
              ],
              tier_7_provisional: [
                {
                  group: "mechanisms",
                  value: "not-new-format",
                  confidence: 0.5,
                },
              ],
            },
          } as never;
        },
      };

      const firstResult = await runProcessCommand({ ai: true, batch: 1 }, processDeps);
      const secondResult = await runProcessCommand({ ai: true, batch: 1 }, processDeps);

      expect(firstResult.mode).toBe("ai");
      expect(secondResult.mode).toBe("ai");
      expect(secondResult.result.failed).toBe(1);

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();

      const classifyJob = verifyDb.db
        .query(
          `
          SELECT status, error_class, error_message
          FROM jobs
          WHERE rhizome_id = ? AND stage = ?
          ORDER BY id DESC
          LIMIT 1;
          `,
        )
        .get(rhizomeId, PipelineStep.CLASSIFY) as {
        status: string;
        error_class: string | null;
        error_message: string | null;
      };

      verifyDb.close();

      expect(classifyJob.status).toBe("paused");
      expect(classifyJob.error_class).toBe("permanent");
      expect(classifyJob.error_message).toContain("Malformed classify taxonomy payload");
    });
  });

  test("process --ai records diagnosable classify failure metadata for malformed fixed-field output", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      const rhizomeId = "550e8400-e29b-41d4-a716-446655440039";
      seedAiSummarizeStudy({
        database,
        rhizomeId,
        citekey: "lane2026classifymalformed",
        title: "Malformed classify fixed fields",
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
          classifyStageRunner: async () => {
            throw {
              message: "Classifier output missing required fixed fields: tier_4.control",
              code: "classifier_output_missing_fixed_fields",
              errorClass: "permanent",
            };
          },
        },
      );

      expect(result.mode).toBe("ai");
      expect(result.result.processed).toBe(2);
      expect(result.result.succeeded).toBe(1);
      expect(result.result.failed).toBe(1);

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();

      const classifyJob = verifyDb.db
        .query(
          `
          SELECT status, error_class, error_message, retry_count, metadata
          FROM jobs
          WHERE rhizome_id = ? AND stage = ?
          ORDER BY id DESC
          LIMIT 1;
          `,
        )
        .get(rhizomeId, PipelineStep.CLASSIFY) as {
        status: string;
        error_class: string | null;
        error_message: string | null;
        retry_count: number;
        metadata: string | null;
      };

      const vaultWriteCount = verifyDb.db
        .query(
          `
          SELECT COUNT(*) AS count
          FROM jobs
          WHERE rhizome_id = ? AND stage = ? AND status = 'complete';
          `,
        )
        .get(rhizomeId, PipelineStep.VAULT_WRITE) as { count: number };

      const pipeline = verifyDb.db
        .query(
          `
          SELECT pipeline_overall, pipeline_steps_json
          FROM studies
          WHERE rhizome_id = ?
          LIMIT 1;
          `,
        )
        .get(rhizomeId) as { pipeline_overall: string; pipeline_steps_json: string };

      verifyDb.close();

      const classifyMetadata = JSON.parse(classifyJob.metadata ?? "{}") as Record<string, unknown>;
      const pipelineSteps = JSON.parse(pipeline.pipeline_steps_json) as Record<
        string,
        { status?: string; retries?: number; error?: string }
      >;

      expect(classifyJob.status).toBe("paused");
      expect(classifyJob.error_class).toBe("permanent");
      expect(classifyJob.error_message).toBe(
        "Classifier output missing required fixed fields: tier_4.control",
      );
      expect(classifyJob.retry_count).toBe(1);
      expect(classifyMetadata.error_class).toBe("permanent");
      expect(classifyMetadata.pause_reason).toBe("permanent_error");
      expect(classifyMetadata.last_error).toBe(
        "Classifier output missing required fixed fields: tier_4.control",
      );

      expect(vaultWriteCount.count).toBe(0);
      expect(pipeline.pipeline_overall).toBe(PipelineOverallStatus.NEEDS_ATTENTION);
      expect(pipelineSteps[PipelineStep.CLASSIFY]?.status).toBe(PipelineStepStatus.FAILED);
      expect(pipelineSteps[PipelineStep.CLASSIFY]?.retries).toBe(1);
      expect(pipelineSteps[PipelineStep.CLASSIFY]?.error).toBe(
        "Classifier output missing required fixed fields: tier_4.control",
      );
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
          classifyStageRunner: async (input) => buildStubClassifyResult(input.study.citekey, vaultPath),
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
          classifyStageRunner: async (input) => buildStubClassifyResult(input.study.citekey, vaultPath),
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
          classifyStageRunner: async (input) => buildStubClassifyResult(input.study.citekey, vaultPath),
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

  test("reprocess --dry-run reports deterministic counters and performs zero mutation", async () => {
    await withTempRhizome(async (root) => {
      const dbPath = join(root, CANONICAL_WORKSPACE_DIR, "siss.db");
      const database = new Database({ path: dbPath });
      database.init();

      seedRetryStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440121",
        citekey: "lane2026reprocessdryrun",
        title: "Reprocess dry-run target",
      });

      database.db
        .query(
          `
          INSERT INTO jobs (rhizome_id, stage, status, retry_count, metadata)
          VALUES
            (?, ?, 'complete', 0, NULL),
            (?, ?, 'error', 2, '{"last_error":"boom"}'),
            (?, ?, 'complete', 0, NULL),
            (?, ?, 'queued', 0, NULL);
          `,
        )
        .run(
          "550e8400-e29b-41d4-a716-446655440121",
          PipelineStep.SUMMARIZE,
          "550e8400-e29b-41d4-a716-446655440121",
          PipelineStep.CLASSIFY,
          "550e8400-e29b-41d4-a716-446655440121",
          PipelineStep.VAULT_WRITE,
          "550e8400-e29b-41d4-a716-446655440121",
          PipelineStep.PDF_FETCH,
        );

      database.close();

      const beforeDb = new Database({ path: dbPath });
      beforeDb.init();
      const beforeRows = beforeDb.db
        .query(
          `
          SELECT stage, status, retry_count, error_message, error_class
          FROM jobs
          WHERE rhizome_id = ?
          ORDER BY id ASC;
          `,
        )
        .all("550e8400-e29b-41d4-a716-446655440121") as Array<{
        stage: string;
        status: string;
        retry_count: number;
        error_message: string | null;
        error_class: string | null;
      }>;
      beforeDb.close();

      const result = await runReprocessCommand(
        {
          citekey: "lane2026reprocessdryrun",
          stage: PipelineStep.SUMMARIZE,
          cascade: true,
          dryRun: true,
          json: true,
        },
        { cwd: root },
      );

      expect(result.dryRun).toBe(true);
      expect(result.matchedStudies).toBe(1);
      expect(result.matchedJobs).toBe(3);
      expect(result.jobsRequeued).toBe(3);
      expect(result.stages).toEqual([PipelineStep.SUMMARIZE, PipelineStep.CLASSIFY, PipelineStep.VAULT_WRITE]);
      expect(result.stageCounters[PipelineStep.SUMMARIZE]).toBe(1);
      expect(result.stageCounters[PipelineStep.CLASSIFY]).toBe(1);
      expect(result.stageCounters[PipelineStep.VAULT_WRITE]).toBe(1);

      const afterDb = new Database({ path: dbPath });
      afterDb.init();
      const afterRows = afterDb.db
        .query(
          `
          SELECT stage, status, retry_count, error_message, error_class
          FROM jobs
          WHERE rhizome_id = ?
          ORDER BY id ASC;
          `,
        )
        .all("550e8400-e29b-41d4-a716-446655440121") as Array<{
        stage: string;
        status: string;
        retry_count: number;
        error_message: string | null;
        error_class: string | null;
      }>;
      afterDb.close();

      expect(afterRows).toEqual(beforeRows);
    });
  });

  test("reprocess mutates selected stage chain and clears transient job error fields", async () => {
    await withTempRhizome(async (root) => {
      const dbPath = join(root, CANONICAL_WORKSPACE_DIR, "siss.db");
      const database = new Database({ path: dbPath });
      database.init();

      seedRetryStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440122",
        citekey: "lane2026reprocessmutate",
        title: "Reprocess mutate target",
      });

      database.db
        .query(
          `
          INSERT INTO jobs (rhizome_id, stage, status, retry_count, error_message, error_class, metadata)
          VALUES
            (?, ?, 'complete', 0, NULL, NULL, NULL),
            (?, ?, 'paused', 3, 'retry exhausted', 'transient', '{"pause_reason":"manual"}'),
            (?, ?, 'error', 1, 'classification failed', 'transient', '{"attempt":1}'),
            (?, ?, 'processing', 0, NULL, NULL, NULL),
            (?, ?, 'complete', 0, NULL, NULL, NULL);
          `,
        )
        .run(
          "550e8400-e29b-41d4-a716-446655440122",
          PipelineStep.SUMMARIZE,
          "550e8400-e29b-41d4-a716-446655440122",
          PipelineStep.CLASSIFY,
          "550e8400-e29b-41d4-a716-446655440122",
          PipelineStep.VAULT_WRITE,
          "550e8400-e29b-41d4-a716-446655440122",
          PipelineStep.FULLTEXT_MARKER,
          "550e8400-e29b-41d4-a716-446655440122",
          PipelineStep.PDF_FETCH,
        );

      database.close();

      const result = await runReprocessCommand(
        {
          citekey: "lane2026reprocessmutate",
          stage: PipelineStep.SUMMARIZE,
          cascade: true,
          json: true,
        },
        { cwd: root },
      );

      expect(result.dryRun).toBe(false);
      expect(result.matchedStudies).toBe(1);
      expect(result.jobsRequeued).toBe(3);
      expect(result.stageCounters[PipelineStep.SUMMARIZE]).toBe(1);
      expect(result.stageCounters[PipelineStep.CLASSIFY]).toBe(1);
      expect(result.stageCounters[PipelineStep.VAULT_WRITE]).toBe(1);

      const verifyDb = new Database({ path: dbPath });
      verifyDb.init();

      const stageRows = verifyDb.db
        .query(
          `
          SELECT stage, status, error_message, error_class
          FROM jobs
          WHERE rhizome_id = ?
          ORDER BY id ASC;
          `,
        )
        .all("550e8400-e29b-41d4-a716-446655440122") as Array<{
        stage: string;
        status: string;
        error_message: string | null;
        error_class: string | null;
      }>;

      verifyDb.close();

      const byStage = new Map(stageRows.map((row) => [row.stage, row]));
      expect(byStage.get(PipelineStep.SUMMARIZE)?.status).toBe("queued");
      expect(byStage.get(PipelineStep.CLASSIFY)?.status).toBe("queued");
      expect(byStage.get(PipelineStep.CLASSIFY)?.error_message).toBeNull();
      expect(byStage.get(PipelineStep.CLASSIFY)?.error_class).toBeNull();
      expect(byStage.get(PipelineStep.VAULT_WRITE)?.status).toBe("queued");
      expect(byStage.get(PipelineStep.PDF_FETCH)?.status).toBe("complete");
    });
  });

  test("reprocess rejects malformed selector/stage/filter combinations", async () => {
    await withTempRhizome(async (root) => {
      await expect(runReprocessCommand({ stage: PipelineStep.SUMMARIZE }, { cwd: root })).rejects.toThrow(
        "Select exactly one reprocess target: use either --citekey <key> or --filter <expr>",
      );

      await expect(
        runReprocessCommand(
          { citekey: "lane2026x", filter: "has_summary=false", stage: PipelineStep.SUMMARIZE },
          { cwd: root },
        ),
      ).rejects.toThrow("Select exactly one reprocess target: use either --citekey <key> or --filter <expr>");

      await expect(runReprocessCommand({ citekey: "   ", stage: PipelineStep.SUMMARIZE }, { cwd: root })).rejects.toThrow(
        "--citekey requires a non-empty value",
      );

      await expect(
        runReprocessCommand({ citekey: "lane2026x", stage: "bogus_stage" }, { cwd: root }),
      ).rejects.toThrow("Unknown stage 'bogus_stage'. Valid stages:");

      await expect(
        runReprocessCommand(
          { filter: "pipeline_overall = 'complete'", stage: PipelineStep.SUMMARIZE },
          { cwd: root },
        ),
      ).rejects.toThrow("Unsupported --filter expression");
    });
  });

  test("reprocess reports unknown citekey, zero-match filters, and lock contention", async () => {
    await withTempRhizome(async (root) => {
      await expect(
        runReprocessCommand(
          { citekey: "lane2026missingstudy", stage: PipelineStep.SUMMARIZE },
          { cwd: root },
        ),
      ).rejects.toThrow("Study not found for citekey=lane2026missingstudy");

      const zeroMatch = await runReprocessCommand(
        {
          filter: "has_summary=true",
          stage: PipelineStep.SUMMARIZE,
          dryRun: true,
          json: true,
        },
        { cwd: root },
      );
      expect(zeroMatch.matchedStudies).toBe(0);
      expect(zeroMatch.matchedJobs).toBe(0);
      expect(zeroMatch.jobsRequeued).toBe(0);

      const config = await loadConfig(join(root, CANONICAL_WORKSPACE_DIR, "config.yaml"));
      const lock = new WriterLock({
        lockPath: join(root, config.pipeline.lock_path),
        staleTimeoutMs: config.pipeline.lock_stale_minutes * 60 * 1000,
      });
      await lock.acquire("rhizome process", 5151);

      await expect(
        runReprocessCommand({ filter: "has_summary=false", stage: PipelineStep.SUMMARIZE }, { cwd: root }),
      ).rejects.toThrow("writer already active");

      await lock.release();
    });
  });

  test("audit returns deterministic filtered run history with JSON-stable null fields", async () => {
    await withTempRhizome(async (root) => {
      const dbPath = join(root, CANONICAL_WORKSPACE_DIR, "siss.db");
      const database = new Database({ path: dbPath });
      database.init();

      seedRetryStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440201",
        citekey: "lane2026audittarget",
        title: "Audit target",
      });
      seedRetryStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440202",
        citekey: "lane2026auditother",
        title: "Audit other",
      });

      seedPipelineRun({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440201",
        runId: "run-target-1",
        step: PipelineStep.SUMMARIZE,
        status: "failed",
        retries: 2,
        error: "summarizer timeout",
        model: null,
        skill: null,
      });
      seedPipelineRun({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440201",
        runId: "run-target-2",
        step: PipelineStep.SUMMARIZE,
        status: "completed",
        retries: 0,
        model: "gpt-4.1-mini",
        skill: "summarize@v2",
      });
      seedPipelineRun({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440202",
        runId: "run-other-1",
        step: PipelineStep.CLASSIFY,
        status: "failed",
        retries: 1,
        error: "classifier error",
        model: "claude-3.5-haiku",
        skill: "classify@v1",
      });

      database.close();

      const citekeyFiltered = await runAuditCommand(
        { citekey: "lane2026audittarget", stage: PipelineStep.SUMMARIZE, json: true },
        { cwd: root },
      );

      expect(citekeyFiltered.filters.citekey).toBe("lane2026audittarget");
      expect(citekeyFiltered.filters.stage).toBe(PipelineStep.SUMMARIZE);
      expect(citekeyFiltered.count).toBe(2);
      expect(citekeyFiltered.runs.map((run) => run.run_id)).toEqual(["run-target-2", "run-target-1"]);
      expect(citekeyFiltered.runs[1]?.model).toBeNull();
      expect(citekeyFiltered.runs[1]?.skill).toBeNull();

      const errorsOnly = await runAuditCommand({ errors: true, json: true }, { cwd: root });
      expect(errorsOnly.runs.every((run) => run.status === "failed" || run.error !== null)).toBe(true);
      expect(errorsOnly.runs.map((run) => run.run_id)).toEqual(["run-other-1", "run-target-1"]);

      const newestSingle = await runAuditCommand({ last: 1, json: true }, { cwd: root });
      expect(newestSingle.count).toBe(1);
      expect(newestSingle.runs[0]?.run_id).toBe("run-other-1");
    });
  });

  test("audit validates malformed options and unknown citekey", async () => {
    await withTempRhizome(async (root) => {
      await expect(runAuditCommand({ last: 0 }, { cwd: root })).rejects.toThrow(
        "--last must be a positive integer between 1 and 200",
      );
      await expect(runAuditCommand({ last: -3 }, { cwd: root })).rejects.toThrow(
        "--last must be a positive integer between 1 and 200",
      );
      await expect(runAuditCommand({ last: Number.NaN }, { cwd: root })).rejects.toThrow(
        "--last must be a positive integer between 1 and 200",
      );
      await expect(runAuditCommand({ stage: "bogus_stage" }, { cwd: root })).rejects.toThrow(
        "Unknown stage 'bogus_stage'. Valid stages:",
      );
      await expect(runAuditCommand({ citekey: "lane2026missingaudit" }, { cwd: root })).rejects.toThrow(
        "Study not found for citekey=lane2026missingaudit",
      );
    });
  });

  test("audit returns stable empty results and caps oversized --last", async () => {
    await withTempRhizome(async (root) => {
      const dbPath = join(root, CANONICAL_WORKSPACE_DIR, "siss.db");
      const database = new Database({ path: dbPath });
      database.init();

      seedRetryStudy({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440203",
        citekey: "lane2026auditempty",
        title: "Audit empty",
      });

      seedPipelineRun({
        database,
        rhizomeId: "550e8400-e29b-41d4-a716-446655440203",
        runId: "run-empty-1",
        step: PipelineStep.PDF_FETCH,
        status: "completed",
      });

      database.close();

      const empty = await runAuditCommand(
        { citekey: "lane2026auditempty", stage: PipelineStep.CLASSIFY, json: true },
        { cwd: root },
      );
      expect(empty.count).toBe(0);
      expect(empty.runs).toEqual([]);
      expect(empty.filters).toEqual({
        citekey: "lane2026auditempty",
        stage: PipelineStep.CLASSIFY,
        errorsOnly: false,
        last: 25,
      });

      const capped = await runAuditCommand({ last: 999, json: true }, { cwd: root });
      expect(capped.filters.last).toBe(200);
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

  test("taxonomy review writes deterministic artifact with proposal IDs", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const taxonomyPath = makeTaxonomyPath(vaultPath);
      await mkdir(join(vaultPath, "Research", "_system"), { recursive: true });
      await writeFile(
        taxonomyPath,
        JSON.stringify(
          {
            version: 1,
            groups: {
              therapeutic_areas: {
                values: {},
                pending: {
                  stress_resilience: {
                    count: 2,
                    first_seen_at: "2026-03-27T00:00:00.000Z",
                    last_seen_at: "2026-03-27T00:00:00.000Z",
                    sources: ["classifier"],
                  },
                },
              },
              mechanisms: { values: {}, pending: {} },
              indications: { values: {}, pending: {} },
              contraindications: { values: {}, pending: {} },
              drug_interactions: { values: {}, pending: {} },
              research_gaps: { values: {}, pending: {} },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const result = await runTaxonomyReviewCommand({ json: true }, { cwd: root });

      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]?.proposal_id).toBe(
        "proposal:therapeutic_areas:rename:stress_resilience",
      );

      const artifactPath = join(vaultPath, "Research", "_system", "taxonomy_review.md");
      const markdown = await readFile(artifactPath, "utf8");
      expect(markdown).toContain("# Taxonomy Review");
      expect(markdown).toContain("proposal:therapeutic_areas:rename:stress_resilience");
    });
  });

  test("taxonomy approve/reject persist decision rows and reject unknown IDs without side effects", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const taxonomyPath = makeTaxonomyPath(vaultPath);
      await mkdir(join(vaultPath, "Research", "_system"), { recursive: true });
      await writeFile(
        taxonomyPath,
        JSON.stringify(
          {
            version: 1,
            groups: {
              therapeutic_areas: {
                values: {},
                pending: {
                  stress_resilience: {
                    count: 2,
                    first_seen_at: "2026-03-27T00:00:00.000Z",
                    last_seen_at: "2026-03-27T00:00:00.000Z",
                    sources: ["classifier"],
                  },
                },
              },
              mechanisms: { values: {}, pending: {} },
              indications: { values: {}, pending: {} },
              contraindications: { values: {}, pending: {} },
              drug_interactions: { values: {}, pending: {} },
              research_gaps: { values: {}, pending: {} },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      await runTaxonomyApproveCommand(
        {
          id: "proposal:therapeutic_areas:rename:stress_resilience",
          by: "qa-user",
          rationale: "looks good",
          json: true,
        },
        { cwd: root },
      );

      const dbPath = join(root, CANONICAL_WORKSPACE_DIR, "siss.db");
      const database = new Database({ path: dbPath });
      database.init();

      const approvedRow = database.db
        .query(
          `
          SELECT decision_status, decided_by, rationale
          FROM taxonomy_proposal_decisions
          WHERE proposal_id = ?
          LIMIT 1;
          `,
        )
        .get("proposal:therapeutic_areas:rename:stress_resilience") as {
        decision_status: string;
        decided_by: string | null;
        rationale: string | null;
      };

      expect(approvedRow.decision_status).toBe("approved");
      expect(approvedRow.decided_by).toBe("qa-user");
      expect(approvedRow.rationale).toBe("looks good");

      await runTaxonomyRejectCommand(
        {
          id: "proposal:therapeutic_areas:rename:stress_resilience",
          rationale: "not now",
          json: true,
        },
        { cwd: root },
      );

      const rejectedRow = database.db
        .query(
          `
          SELECT decision_status, rationale
          FROM taxonomy_proposal_decisions
          WHERE proposal_id = ?
          LIMIT 1;
          `,
        )
        .get("proposal:therapeutic_areas:rename:stress_resilience") as {
        decision_status: string;
        rationale: string | null;
      };
      expect(rejectedRow.decision_status).toBe("rejected");
      expect(rejectedRow.rationale).toBe("not now");

      const beforeUnknownCount = database.db
        .query("SELECT COUNT(*) AS count FROM taxonomy_proposal_decisions;")
        .get() as { count: number };

      await expect(
        runTaxonomyApproveCommand(
          {
            id: "proposal:therapeutic_areas:rename:unknown_value",
          },
          { cwd: root },
        ),
      ).rejects.toThrow("Unknown proposal id");

      const afterUnknownCount = database.db
        .query("SELECT COUNT(*) AS count FROM taxonomy_proposal_decisions;")
        .get() as { count: number };

      expect(afterUnknownCount.count).toBe(beforeUnknownCount.count);
      database.close();
    });
  });

  test("taxonomy apply rewrites approved proposals only", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const taxonomyPath = makeTaxonomyPath(vaultPath);
      await mkdir(join(vaultPath, "Research", "_system"), { recursive: true });
      await mkdir(join(vaultPath, "Research", "studies"), { recursive: true });

      await writeFile(
        taxonomyPath,
        JSON.stringify(
          {
            version: 1,
            groups: {
              therapeutic_areas: {
                values: {},
                pending: {
                  stress_resilience: {
                    count: 2,
                    first_seen_at: "2026-03-27T00:00:00.000Z",
                    last_seen_at: "2026-03-27T00:00:00.000Z",
                    sources: ["classifier"],
                  },
                },
              },
              mechanisms: { values: {}, pending: {} },
              indications: { values: {}, pending: {} },
              contraindications: { values: {}, pending: {} },
              drug_interactions: { values: {}, pending: {} },
              research_gaps: { values: {}, pending: {} },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const studyNotePath = join(vaultPath, "Research", "studies", "lane2026apply.md");
      await writeFile(
        studyNotePath,
        matter.stringify("# Study\n", {
          note_type: "study",
          has_pdf: false,
          has_fulltext: false,
          has_summary: false,
          has_classification: true,
          pipeline_status: "partial",
          title: "Apply test",
          authors: [{ family: "Lane", given: "A" }],
          year: 2026,
          pdf_available: false,
          tier_6_taxonomy: {
            therapeutic_areas: ["stress_resilience"],
            mechanisms: [],
            indications: [],
            contraindications: [],
            drug_interactions: [],
            research_gaps: [],
          },
          tier_7_provisional: [
            {
              group: "therapeutic_areas",
              value: "new:stress_resilience",
              confidence: 0.8,
              proposed_by: "classifier",
              logged_at: "2026-03-27T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await runTaxonomyApproveCommand(
        { id: "proposal:therapeutic_areas:rename:stress_resilience", json: true },
        { cwd: root },
      );

      const result = await runTaxonomyApplyCommand({ json: true }, { cwd: root });
      expect(result.decisionCount).toBe(1);
      expect(result.completed).toBe(1);

      const parsed = matter(await readFile(studyNotePath, "utf8"));
      const frontmatter = parseStudyFrontmatter(parsed.data);
      expect(frontmatter.tier_6_taxonomy?.therapeutic_areas).toEqual(["stress_resilience"]);
      expect(frontmatter.tier_7_provisional).toEqual([]);

      const updatedTaxonomy = JSON.parse(await readFile(taxonomyPath, "utf8")) as {
        groups: {
          therapeutic_areas: {
            pending: Record<string, unknown>;
            values: Record<string, { aliases: string[]; count: number }>;
          };
        };
      };
      expect(updatedTaxonomy.groups.therapeutic_areas.pending.stress_resilience).toBeUndefined();
      expect(updatedTaxonomy.groups.therapeutic_areas.values.stress_resilience.count).toBe(2);

      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();
      const checkpoint = database.db
        .query(
          `
          SELECT status, processed_notes, total_notes
          FROM taxonomy_propagation_checkpoints
          WHERE proposal_id = ?
          LIMIT 1;
          `,
        )
        .get("proposal:therapeutic_areas:rename:stress_resilience") as {
        status: string;
        processed_notes: number;
        total_notes: number;
      };
      database.close();

      expect(checkpoint.status).toBe("completed");
      expect(checkpoint.processed_notes).toBe(1);
      expect(checkpoint.total_notes).toBe(1);
    });
  });

  test("taxonomy apply --resume continues from failed checkpoint", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      const taxonomyPath = makeTaxonomyPath(vaultPath);
      await mkdir(join(vaultPath, "Research", "_system"), { recursive: true });
      await mkdir(join(vaultPath, "Research", "studies"), { recursive: true });

      await writeFile(
        taxonomyPath,
        JSON.stringify(
          {
            version: 1,
            groups: {
              therapeutic_areas: { values: {}, pending: {} },
              mechanisms: {
                values: {},
                pending: {
                  hpa_axis_resilience: {
                    count: 1,
                    first_seen_at: "2026-03-27T00:00:00.000Z",
                    last_seen_at: "2026-03-27T00:00:00.000Z",
                    sources: ["classifier"],
                  },
                },
              },
              indications: { values: {}, pending: {} },
              contraindications: { values: {}, pending: {} },
              drug_interactions: { values: {}, pending: {} },
              research_gaps: { values: {}, pending: {} },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const firstNote = join(vaultPath, "Research", "studies", "lane2026resumea.md");
      const secondNote = join(vaultPath, "Research", "studies", "lane2026resumeb.md");

      const validNote = matter.stringify("# A\n", {
        note_type: "study",
        has_pdf: false,
        has_fulltext: false,
        has_summary: false,
        has_classification: true,
        pipeline_status: "partial",
        title: "A",
        authors: [{ family: "Lane", given: "A" }],
        year: 2026,
        pdf_available: false,
        tier_6_taxonomy: {
          therapeutic_areas: [],
          mechanisms: ["hpa_axis_resilience"],
          indications: [],
          contraindications: [],
          drug_interactions: [],
          research_gaps: [],
        },
        tier_7_provisional: [],
      });

      await writeFile(firstNote, validNote, "utf8");
      await writeFile(secondNote, "---\ntitle: bad\n", "utf8");

      await runTaxonomyApproveCommand(
        { id: "proposal:mechanisms:rename:hpa_axis_resilience", json: true },
        { cwd: root },
      );

      await expect(runTaxonomyApplyCommand({ json: true }, { cwd: root })).rejects.toThrow(
        "Malformed frontmatter",
      );

      await writeFile(secondNote, validNote.replace("# A", "# B"), "utf8");

      const resumeResult = await runTaxonomyApplyCommand({ resume: true, json: true }, { cwd: root });
      expect(resumeResult.completed).toBe(1);

      const db = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      db.init();
      const checkpoint = db.db
        .query(
          `
          SELECT status, processed_notes, total_notes
          FROM taxonomy_propagation_checkpoints
          WHERE proposal_id = ?
          LIMIT 1;
          `,
        )
        .get("proposal:mechanisms:rename:hpa_axis_resilience") as {
        status: string;
        processed_notes: number;
        total_notes: number;
      };
      db.close();

      expect(checkpoint.status).toBe("completed");
      expect(checkpoint.processed_notes).toBe(2);
      expect(checkpoint.total_notes).toBe(2);
    });
  });

  test("taxonomy review -> approve/reject -> apply cycle stays idempotent across resume reruns", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      await writeTaxonomyFixture({
        vaultPath,
        therapeuticPending: {
          stress_resilience: { count: 2 },
          sleep_quality: { count: 1 },
        },
      });

      await mkdir(join(vaultPath, "Research", "studies"), { recursive: true });
      const studyPath = join(vaultPath, "Research", "studies", "lane2026cycle.md");
      await writeFile(
        studyPath,
        matter.stringify("# Study\n", {
          note_type: "study",
          has_pdf: false,
          has_fulltext: false,
          has_summary: false,
          has_classification: true,
          pipeline_status: "partial",
          title: "Cycle test",
          authors: [{ family: "Lane", given: "A" }],
          year: 2026,
          pdf_available: false,
          tier_6_taxonomy: {
            therapeutic_areas: ["stress_resilience", "sleep_quality"],
            mechanisms: [],
            indications: [],
            contraindications: [],
            drug_interactions: [],
            research_gaps: [],
          },
          tier_7_provisional: [
            {
              group: "therapeutic_areas",
              value: "new:stress_resilience",
              confidence: 0.8,
              proposed_by: "classifier",
              logged_at: "2026-03-27T00:00:00.000Z",
            },
            {
              group: "therapeutic_areas",
              value: "new:sleep_quality",
              confidence: 0.7,
              proposed_by: "classifier",
              logged_at: "2026-03-27T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      const review = await runTaxonomyReviewCommand({ json: true }, { cwd: root });
      expect(review.proposals).toHaveLength(2);

      await runTaxonomyApproveCommand(
        { id: "proposal:therapeutic_areas:rename:stress_resilience", json: true },
        { cwd: root },
      );
      await runTaxonomyRejectCommand(
        { id: "proposal:therapeutic_areas:rename:sleep_quality", json: true },
        { cwd: root },
      );

      const applyOnce = await runTaxonomyApplyCommand({ json: true }, { cwd: root });
      expect(applyOnce.decisionCount).toBe(1);
      expect(applyOnce.completed).toBe(1);
      expect(applyOnce.skipped).toBe(0);

      const applyTwice = await runTaxonomyApplyCommand({ json: true }, { cwd: root });
      expect(applyTwice.decisionCount).toBe(1);
      expect(applyTwice.completed).toBe(0);
      expect(applyTwice.skipped).toBe(1);

      const resumeAfterComplete = await runTaxonomyApplyCommand({ resume: true, json: true }, { cwd: root });
      expect(resumeAfterComplete.decisionCount).toBe(1);
      expect(resumeAfterComplete.completed).toBe(0);
      expect(resumeAfterComplete.skipped).toBe(1);

      const parsed = matter(await readFile(studyPath, "utf8"));
      const frontmatter = parseStudyFrontmatter(parsed.data);
      expect(frontmatter.tier_6_taxonomy?.therapeutic_areas).toEqual(["stress_resilience", "sleep_quality"]);
      expect(frontmatter.tier_7_provisional?.map((entry) => entry.value)).toEqual(["new:sleep_quality"]);
    });
  });

  test("taxonomy mutating commands respect writer lock contention with holder diagnostics", async () => {
    await withTempRhizome(async (root, vaultPath) => {
      await writeTaxonomyFixture({
        vaultPath,
        therapeuticPending: {
          stress_resilience: { count: 1 },
        },
      });

      const lockPath = join(root, CANONICAL_WORKSPACE_DIR, "locks", "mutator.lock");
      const lock = new WriterLock({ lockPath });
      await lock.acquire("rhizome process --ai", 4242);

      await expect(
        runTaxonomyApproveCommand(
          { id: "proposal:therapeutic_areas:rename:stress_resilience" },
          { cwd: root },
        ),
      ).rejects.toThrow("writer already active");
      await expect(
        runTaxonomyApproveCommand(
          { id: "proposal:therapeutic_areas:rename:stress_resilience" },
          { cwd: root },
        ),
      ).rejects.toThrow("pid=4242");

      await expect(
        runTaxonomyRejectCommand(
          { id: "proposal:therapeutic_areas:rename:stress_resilience" },
          { cwd: root },
        ),
      ).rejects.toThrow("command=rhizome process --ai");

      await expect(runTaxonomyApplyCommand({ json: true }, { cwd: root })).rejects.toThrow(
        "writer already active",
      );

      await lock.release();
    });
  });

  test("taxonomy CLI wiring exposes reject subcommand and enforces required --id", () => {
    const program = createCliProgram();
    const taxonomyCommand = program.commands.find((command) => command.name() === "taxonomy");
    expect(taxonomyCommand).toBeDefined();
    expect(taxonomyCommand?.commands.map((command) => command.name()).sort()).toEqual([
      "apply",
      "approve",
      "reject",
      "review",
    ]);

    const rejectCommand = taxonomyCommand?.commands.find((command) => command.name() === "reject");
    expect(rejectCommand).toBeDefined();
    expect(
      rejectCommand?.options.some((option) => option.required && option.long === "--id"),
    ).toBe(true);
  });
  test("taxonomy approve rejects malformed and empty proposal IDs", async () => {
    await withTempRhizome(async (root) => {
      await expect(runTaxonomyApproveCommand({ id: "" }, { cwd: root })).rejects.toThrow(
        "--id requires a non-empty value",
      );

      await expect(
        runTaxonomyApproveCommand({ id: "bad-id" }, { cwd: root }),
      ).rejects.toThrow("Invalid proposal id");
    });
  });
});
