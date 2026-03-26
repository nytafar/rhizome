import { join, relative } from "node:path";
import { loadConfig, type RhizomeConfig } from "../../config/loader";
import { resolveWorkspaceConfigPath } from "../../config/workspace-contract";
import { Database } from "../../db/database";
import { WriterLock, WriterLockError } from "../../lock/writer-lock";
import {
  PipelineOrchestrator,
  type PipelineOrchestratorEvent,
  type ProcessResult,
} from "../../pipeline/orchestrator";
import {
  PipelineOverallStatus,
  PipelineStep,
  type PipelineStepState,
} from "../../types/pipeline";
import { runSummarizeStage } from "../../stages/summarize";
import { runVaultWriteStage } from "../../stages/vault-write";
import type { StudyRecord } from "../../types/study";
import type { Database as BunSQLiteDatabase } from "bun:sqlite";
import { getVaultFolderStructurePaths } from "../../vault/folder-creator";

interface SummarizeStudyRow {
  citekey: string;
  title: string | null;
  doi: string | null;
  pmid: string | null;
}

interface VaultWriteStudyRow {
  rhizome_id: string;
  citekey: string;
  title: string | null;
  doi: string | null;
  pmid: string | null;
  zotero_key: string | null;
  zotero_version: number | null;
  zotero_sync_status: string | null;
  removed_upstream_at: string | null;
  removed_upstream_reason: string | null;
  source_collections_json: string | null;
  source: string;
  pipeline_overall: string;
  pipeline_error: string | null;
  pipeline_steps_json: string;
}

export interface ProcessCommandOptions {
  ai?: boolean;
  batch?: number;
  citekey?: string;
}

export interface ProcessCommandResult {
  mode: "ai" | "non_ai";
  result: ProcessResult;
}

export interface ProcessCommandDeps {
  cwd?: string;
  stdout?: Pick<typeof process.stdout, "write">;
  loadConfigFn?: (configPath: string) => Promise<RhizomeConfig>;
  onEvent?: (event: PipelineOrchestratorEvent) => void;
}

function normalizeCitekeyOption(citekey: string): string {
  const normalized = citekey.trim();
  if (normalized.length === 0) {
    throw new Error("--citekey requires a non-empty value");
  }
  return normalized;
}

function resolveDbPath(cwd: string, config: RhizomeConfig): string {
  return join(cwd, config.data.db_path);
}

function resolveLockPath(cwd: string, config: RhizomeConfig): string {
  return join(cwd, config.pipeline.lock_path);
}

function resolveSkillsDir(cwd: string, config: RhizomeConfig): string {
  return join(cwd, config.data.skills_dir);
}

function resolveAssetsRootDir(config: RhizomeConfig): string {
  const paths = getVaultFolderStructurePaths({
    vaultPath: config.vault.path,
    vault: config.vault,
  });

  return join(paths.researchRootDir, config.vault.studies_folder, config.vault.assets_folder);
}

function buildCommandLabel(options: ProcessCommandOptions): string {
  const parts = ["rhizome process"];
  if (options.ai) {
    parts.push("--ai");
  }
  if (typeof options.batch === "number") {
    parts.push(`--batch ${options.batch}`);
  }
  if (typeof options.citekey === "string") {
    parts.push(`--citekey ${normalizeCitekeyOption(options.citekey)}`);
  }
  return parts.join(" ");
}

function resolveRhizomeIdByCitekey(db: BunSQLiteDatabase, citekey: string): string {
  const normalized = normalizeCitekeyOption(citekey);

  const row = db
    .query(
      `
      SELECT rhizome_id
      FROM studies
      WHERE citekey = ?
      LIMIT 1;
      `,
    )
    .get(normalized) as { rhizome_id: string } | null;

  if (!row) {
    throw new Error(`Study not found for citekey=${normalized}`);
  }

  return row.rhizome_id;
}

function loadStudyForSummarize(db: BunSQLiteDatabase, rhizomeId: string): SummarizeStudyRow {
  const row = db
    .query(
      `
      SELECT citekey, title, doi, pmid
      FROM studies
      WHERE rhizome_id = ?
      LIMIT 1;
      `,
    )
    .get(rhizomeId) as SummarizeStudyRow | null;

  if (!row) {
    throw new Error(`Study not found for rhizome_id=${rhizomeId}`);
  }

  return row;
}

function parsePipelineSteps(raw: string): Record<string, PipelineStepState> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, PipelineStepState>;
    }
  } catch {
    // fallback to empty object
  }

  return {};
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function parseStringArrayJson(value: string | null | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parseStringArray(parsed);
  } catch {
    return undefined;
  }
}

function extractSummaryPathFromJobMetadata(
  db: BunSQLiteDatabase,
  rhizomeId: string,
  vaultPath: string,
): string | undefined {
  const row = db
    .query(
      `
      SELECT metadata
      FROM jobs
      WHERE rhizome_id = ?
        AND stage = ?
        AND status = 'complete'
        AND metadata IS NOT NULL
      ORDER BY id DESC
      LIMIT 1;
      `,
    )
    .get(rhizomeId, PipelineStep.SUMMARIZE) as { metadata: string } | null;

  if (!row?.metadata) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(row.metadata) as { summaryPath?: unknown };
    if (typeof parsed.summaryPath !== "string" || parsed.summaryPath.trim().length === 0) {
      return undefined;
    }

    const relativePath = relative(vaultPath, parsed.summaryPath);
    if (relativePath.startsWith("..") || relativePath.length === 0) {
      return undefined;
    }

    return relativePath.replaceAll("\\", "/");
  } catch {
    return undefined;
  }
}

function findLastPipelineRunDate(db: BunSQLiteDatabase, rhizomeId: string): string | undefined {
  const row = db
    .query(
      `
      SELECT completed_at, started_at
      FROM pipeline_runs
      WHERE rhizome_id = ?
      ORDER BY id DESC
      LIMIT 1;
      `,
    )
    .get(rhizomeId) as { completed_at: string | null; started_at: string | null } | null;

  const candidate = row?.completed_at ?? row?.started_at;
  if (!candidate || candidate.length < 10) {
    return undefined;
  }

  return candidate.slice(0, 10);
}

function normalizePipelineOverall(value: string): PipelineOverallStatus {
  if (Object.values(PipelineOverallStatus).includes(value as PipelineOverallStatus)) {
    return value as PipelineOverallStatus;
  }

  return PipelineOverallStatus.NOT_STARTED;
}

function loadStudyForVaultWrite(params: {
  db: BunSQLiteDatabase;
  rhizomeId: string;
  config: RhizomeConfig;
  now: () => Date;
}): StudyRecord {
  const row = params.db
    .query(
      `
      SELECT
        rhizome_id,
        citekey,
        title,
        doi,
        pmid,
        zotero_key,
        zotero_version,
        zotero_sync_status,
        removed_upstream_at,
        removed_upstream_reason,
        source_collections_json,
        source,
        pipeline_overall,
        pipeline_error,
        pipeline_steps_json
      FROM studies
      WHERE rhizome_id = ?
      LIMIT 1;
      `,
    )
    .get(params.rhizomeId) as VaultWriteStudyRow | null;

  if (!row) {
    throw new Error(`Study not found for rhizome_id=${params.rhizomeId}`);
  }

  const pipelineSteps = parsePipelineSteps(row.pipeline_steps_json);
  const summaryPath = extractSummaryPathFromJobMetadata(params.db, row.rhizome_id, params.config.vault.path);
  const lastPipelineRun =
    findLastPipelineRunDate(params.db, row.rhizome_id) ?? params.now().toISOString().slice(0, 10);

  return {
    siss_id: row.rhizome_id,
    rhizome_id: row.rhizome_id,
    citekey: row.citekey,
    title: row.title?.trim() || "Untitled study",
    authors: [{ family: "Unknown", given: "Unknown" }],
    year: params.now().getUTCFullYear(),
    doi: row.doi ?? undefined,
    pmid: row.pmid ?? undefined,
    zotero_key: row.zotero_key ?? undefined,
    zotero_version: row.zotero_version ?? undefined,
    zotero_sync_status:
      row.zotero_sync_status === "removed_upstream" ? "removed_upstream" : "active",
    removed_upstream_at: row.removed_upstream_at ?? null,
    removed_upstream_reason: row.removed_upstream_reason ?? null,
    pipeline_overall: normalizePipelineOverall(row.pipeline_overall),
    pipeline_steps: pipelineSteps,
    pipeline_error: row.pipeline_error,
    source: row.source,
    source_collections: parseStringArrayJson(row.source_collections_json),
    summary_path: summaryPath,
    pdf_available: false,
    last_pipeline_run: lastPipelineRun,
  };
}

function combineResults(...results: ProcessResult[]): ProcessResult {
  return results.reduce<ProcessResult>(
    (acc, item) => ({
      processed: acc.processed + item.processed,
      succeeded: acc.succeeded + item.succeeded,
      failed: acc.failed + item.failed,
      enqueued: acc.enqueued + item.enqueued,
    }),
    {
      processed: 0,
      succeeded: 0,
      failed: 0,
      enqueued: 0,
    },
  );
}

function registerBuiltInStageHandlers(
  orchestrator: PipelineOrchestrator,
  params: {
    db: BunSQLiteDatabase;
    config: RhizomeConfig;
    cwd: string;
    now: () => Date;
  },
): void {
  orchestrator.registerStageHandler(PipelineStep.INGEST, async () => {
    return {
      metadata: {
        stage: PipelineStep.INGEST,
        action: "noop",
      },
    };
  });

  orchestrator.registerStageHandler(PipelineStep.ZOTERO_SYNC, async () => {
    return {
      metadata: {
        stage: PipelineStep.ZOTERO_SYNC,
        action: "noop",
      },
    };
  });

  orchestrator.registerStageHandler(PipelineStep.SUMMARIZE, async ({ job }) => {
    const study = loadStudyForSummarize(params.db, job.rhizomeId);

    const summary = await runSummarizeStage({
      study: {
        citekey: study.citekey,
        title: study.title ?? "Untitled study",
        authors: [{ family: "Unknown", given: "Unknown" }],
        year: params.now().getUTCFullYear(),
        doi: study.doi ?? undefined,
        pmid: study.pmid ?? undefined,
        abstract: undefined,
      },
      skillsDir: resolveSkillsDir(params.cwd, params.config),
      summarizerSkillFile: params.config.ai.summarizer.skill_file,
      skillVersion: "v1",
      model: "claude",
      claudeBinary: params.config.ai.claude_binary,
      timeoutMs: params.config.ai.summarizer.timeout_ms,
      maxTurns: params.config.ai.summarizer.max_turns,
      assetsRootDir: resolveAssetsRootDir(params.config),
    });

    return {
      metadata: {
        summaryPath: summary.summaryPath,
        model: summary.metadata.model,
        source: summary.metadata.source,
      },
    };
  });

  orchestrator.registerStageHandler(PipelineStep.VAULT_WRITE, async ({ job }) => {
    const study = loadStudyForVaultWrite({
      db: params.db,
      rhizomeId: job.rhizomeId,
      config: params.config,
      now: params.now,
    });

    const result = await runVaultWriteStage({
      db: params.db,
      study,
      vaultPath: params.config.vault.path,
      vault: {
        research_root: params.config.vault.research_root,
        studies_folder: params.config.vault.studies_folder,
        assets_folder: params.config.vault.assets_folder,
      },
      now: params.now,
    });

    return {
      metadata: {
        notePath: result.notePathRelative,
        assetDir: result.assetDirRelative,
        frontmatterValid: result.metadata.frontmatterValid,
      },
    };
  });
}

export async function runProcessCommand(
  options: ProcessCommandOptions,
  deps: ProcessCommandDeps = {},
): Promise<ProcessCommandResult> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;

  const configPath = await resolveWorkspaceConfigPath(cwd);
  const config = await (deps.loadConfigFn ?? loadConfig)(configPath);

  const database = new Database({ path: resolveDbPath(cwd, config) });
  database.init();

  const lock = new WriterLock({
    lockPath: resolveLockPath(cwd, config),
    staleTimeoutMs: config.pipeline.lock_stale_minutes * 60 * 1000,
  });

  try {
    await lock.acquire(buildCommandLabel(options));
  } catch (error) {
    database.close();

    if (error instanceof WriterLockError) {
      const holder = error.metadata
        ? ` (pid=${error.metadata.pid}, command=${error.metadata.command})`
        : "";
      throw new Error(`${error.message}${holder}`);
    }

    throw error;
  }

  try {
    const targetRhizomeId =
      typeof options.citekey === "string"
        ? resolveRhizomeIdByCitekey(database.db, options.citekey)
        : undefined;

    const orchestrator = new PipelineOrchestrator({
      db: database.db,
      targetRhizomeId,
      onEvent: deps.onEvent,
    });

    registerBuiltInStageHandlers(orchestrator, {
      db: database.db,
      config,
      cwd,
      now: () => new Date(),
    });

    const aiMode = options.ai === true;
    const result = aiMode
      ? combineResults(
          await orchestrator.processNonAI(),
          await orchestrator.processAI({ batchSize: options.batch }),
          await orchestrator.processNonAI(),
        )
      : await orchestrator.processNonAI();

    stdout.write(
      `Process ${aiMode ? "AI" : "non-AI"} complete: processed=${result.processed}, succeeded=${result.succeeded}, failed=${result.failed}, enqueued=${result.enqueued}\n`,
    );

    return {
      mode: aiMode ? "ai" : "non_ai",
      result,
    };
  } finally {
    await lock.release();
    database.close();
  }
}
