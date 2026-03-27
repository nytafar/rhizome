import { isAbsolute, join, relative } from "node:path";
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
import { runPdfFetchStage } from "../../stages/pdf-fetch";
import { runFulltextMarkerStage } from "../../stages/fulltext-marker";
import { runVaultWriteStage } from "../../stages/vault-write";
import { ParserRegistry } from "../../parser/registry";
import { MarkerProvider } from "../../parser/marker-provider";
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
  siss_id: string;
  citekey: string;
  title: string | null;
  doi: string | null;
  pmid: string | null;
  source: string;
  pipeline_overall: string;
  pipeline_error: string | null;
  pipeline_steps_json: string;
}

export interface ProcessCommandOptions {
  ai?: boolean;
  batch?: number;
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

function resolveMarkerBinaryPath(cwd: string, config: RhizomeConfig): string {
  const pythonEnvPath = config.parser.marker.python_env;
  const pythonEnvRoot = isAbsolute(pythonEnvPath) ? pythonEnvPath : join(cwd, pythonEnvPath);
  return join(pythonEnvRoot, "bin", "marker_single");
}

function buildCommandLabel(options: ProcessCommandOptions): string {
  const parts = ["rhizome process"];
  if (options.ai) {
    parts.push("--ai");
  }
  if (typeof options.batch === "number") {
    parts.push(`--batch ${options.batch}`);
  }
  return parts.join(" ");
}

function loadStudyForSummarize(db: BunSQLiteDatabase, sissId: string): SummarizeStudyRow {
  const row = db
    .query(
      `
      SELECT citekey, title, doi, pmid
      FROM studies
      WHERE siss_id = ?
      LIMIT 1;
      `,
    )
    .get(sissId) as SummarizeStudyRow | null;

  if (!row) {
    throw new Error(`Study not found for siss_id=${sissId}`);
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

function extractSummaryPathFromJobMetadata(
  db: BunSQLiteDatabase,
  sissId: string,
  vaultPath: string,
): string | undefined {
  const row = db
    .query(
      `
      SELECT metadata
      FROM jobs
      WHERE siss_id = ?
        AND stage = ?
        AND status = 'complete'
        AND metadata IS NOT NULL
      ORDER BY id DESC
      LIMIT 1;
      `,
    )
    .get(sissId, PipelineStep.SUMMARIZE) as { metadata: string } | null;

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

function extractPdfFetchMetadataFromJobMetadata(
  db: BunSQLiteDatabase,
  sissId: string,
  vaultPath: string,
): { pdfAvailable: boolean; pdfSource?: StudyRecord["pdf_source"]; pdfPath?: string } {
  const row = db
    .query(
      `
      SELECT metadata
      FROM jobs
      WHERE siss_id = ?
        AND stage = ?
        AND status = 'complete'
        AND metadata IS NOT NULL
      ORDER BY id DESC
      LIMIT 1;
      `,
    )
    .get(sissId, PipelineStep.PDF_FETCH) as { metadata: string } | null;

  if (!row?.metadata) {
    return { pdfAvailable: false };
  }

  try {
    const parsed = JSON.parse(row.metadata) as {
      pdfAvailable?: unknown;
      pdfSource?: unknown;
      pdfPath?: unknown;
    };

    const pdfAvailable = parsed.pdfAvailable === true;
    const pdfSource =
      parsed.pdfSource === "zotero" ||
      parsed.pdfSource === "europepmc" ||
      parsed.pdfSource === "unpaywall" ||
      parsed.pdfSource === "openalex" ||
      parsed.pdfSource === "manual"
        ? parsed.pdfSource
        : undefined;

    let pdfPath: string | undefined;
    if (typeof parsed.pdfPath === "string" && parsed.pdfPath.trim().length > 0) {
      const relativePath = relative(vaultPath, parsed.pdfPath);
      if (!relativePath.startsWith("..") && relativePath.length > 0) {
        pdfPath = relativePath.replaceAll("\\", "/");
      }
    }

    return { pdfAvailable, pdfSource, pdfPath };
  } catch {
    return { pdfAvailable: false };
  }
}

function extractFulltextPathFromJobMetadata(
  db: BunSQLiteDatabase,
  sissId: string,
  vaultPath: string,
): string | undefined {
  const row = db
    .query(
      `
      SELECT metadata
      FROM jobs
      WHERE siss_id = ?
        AND stage = ?
        AND status = 'complete'
        AND metadata IS NOT NULL
      ORDER BY id DESC
      LIMIT 1;
      `,
    )
    .get(sissId, PipelineStep.FULLTEXT_MARKER) as { metadata: string } | null;

  if (!row?.metadata) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(row.metadata) as { fulltextPath?: unknown };
    if (typeof parsed.fulltextPath !== "string" || parsed.fulltextPath.trim().length === 0) {
      return undefined;
    }

    const relativePath = relative(vaultPath, parsed.fulltextPath);
    if (relativePath.startsWith("..") || relativePath.length === 0) {
      return undefined;
    }

    return relativePath.replaceAll("\\", "/");
  } catch {
    return undefined;
  }
}

function normalizePipelineOverall(value: string): PipelineOverallStatus {
  if (Object.values(PipelineOverallStatus).includes(value as PipelineOverallStatus)) {
    return value as PipelineOverallStatus;
  }

  return PipelineOverallStatus.NOT_STARTED;
}

function loadStudyForVaultWrite(params: {
  db: BunSQLiteDatabase;
  sissId: string;
  config: RhizomeConfig;
  now: () => Date;
}): StudyRecord {
  const row = params.db
    .query(
      `
      SELECT
        siss_id,
        citekey,
        title,
        doi,
        pmid,
        source,
        pipeline_overall,
        pipeline_error,
        pipeline_steps_json
      FROM studies
      WHERE siss_id = ?
      LIMIT 1;
      `,
    )
    .get(params.sissId) as VaultWriteStudyRow | null;

  if (!row) {
    throw new Error(`Study not found for siss_id=${params.sissId}`);
  }

  const pipelineSteps = parsePipelineSteps(row.pipeline_steps_json);
  const zoteroSyncStep = pipelineSteps[PipelineStep.ZOTERO_SYNC] as Record<string, unknown> | undefined;
  const summaryPath = extractSummaryPathFromJobMetadata(params.db, row.siss_id, params.config.vault.path);
  const fulltextPath = extractFulltextPathFromJobMetadata(
    params.db,
    row.siss_id,
    params.config.vault.path,
  );
  const pdfMetadata = extractPdfFetchMetadataFromJobMetadata(
    params.db,
    row.siss_id,
    params.config.vault.path,
  );

  return {
    siss_id: row.siss_id,
    citekey: row.citekey,
    title: row.title?.trim() || "Untitled study",
    authors: [{ family: "Unknown", given: "Unknown" }],
    year: params.now().getUTCFullYear(),
    doi: row.doi ?? undefined,
    pmid: row.pmid ?? undefined,
    zotero_key: typeof zoteroSyncStep?.zotero_key === "string" ? zoteroSyncStep.zotero_key : undefined,
    zotero_version:
      typeof zoteroSyncStep?.zotero_version === "number" ? zoteroSyncStep.zotero_version : undefined,
    zotero_sync_status:
      zoteroSyncStep?.zotero_sync_status === "removed_upstream" ? "removed_upstream" : "active",
    removed_upstream_at:
      typeof zoteroSyncStep?.removed_upstream_at === "string"
        ? zoteroSyncStep.removed_upstream_at
        : null,
    removed_upstream_reason:
      typeof zoteroSyncStep?.removed_upstream_reason === "string"
        ? zoteroSyncStep.removed_upstream_reason
        : null,
    pipeline_overall: normalizePipelineOverall(row.pipeline_overall),
    pipeline_steps: pipelineSteps,
    pipeline_error: row.pipeline_error,
    source: row.source,
    source_collections: parseStringArray(zoteroSyncStep?.source_collections),
    fulltext_path: fulltextPath,
    summary_path: summaryPath,
    pdf_available: pdfMetadata.pdfAvailable,
    pdf_source: pdfMetadata.pdfSource,
    pdf_path: pdfMetadata.pdfPath,
    last_pipeline_run: params.now().toISOString().slice(0, 10),
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
  const assetsRootDir = resolveAssetsRootDir(params.config);
  const parserRegistry = ParserRegistry.fromConfig(params.config, [
    new MarkerProvider({
      markerBinary: resolveMarkerBinaryPath(params.cwd, params.config),
      markerVersion: params.config.parser.marker.version,
      defaultTimeoutMs: params.config.parser.marker.timeout_ms,
      defaultForceOcr: params.config.parser.marker.force_ocr,
    }),
  ]);

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

  orchestrator.registerStageHandler(PipelineStep.PDF_FETCH, async ({ job }) => {
    const result = await runPdfFetchStage({
      db: params.db,
      sissId: job.sissId,
      assetsRootDir,
      sourceOrder: params.config.pdf.sources,
      maxFileSizeMb: params.config.pdf.max_file_size_mb,
    });

    return {
      metadata: result.metadata,
    };
  });

  orchestrator.registerStageHandler(PipelineStep.FULLTEXT_MARKER, async ({ job }) => {
    const result = await runFulltextMarkerStage({
      db: params.db,
      sissId: job.sissId,
      assetsRootDir,
      parserRegistry,
    });

    return {
      metadata: result.metadata,
    };
  });

  orchestrator.registerStageHandler(PipelineStep.SUMMARIZE, async ({ job }) => {
    const study = loadStudyForSummarize(params.db, job.sissId);

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
      assetsRootDir,
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
      sissId: job.sissId,
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
    const orchestrator = new PipelineOrchestrator({
      db: database.db,
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
