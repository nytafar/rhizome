import { join } from "node:path";
import { loadConfig, type RhizomeConfig } from "../../config/loader";
import { Database } from "../../db/database";
import { WriterLock, WriterLockError } from "../../lock/writer-lock";
import {
  PipelineOrchestrator,
  type PipelineOrchestratorEvent,
  type ProcessResult,
  type StageHandler,
} from "../../pipeline/orchestrator";
import { PipelineStep } from "../../types/pipeline";
import { runSummarizeStage } from "../../stages/summarize";
import type { Database as BunSQLiteDatabase } from "bun:sqlite";
import { getVaultFolderStructurePaths } from "../../vault/folder-creator";

interface SummarizeStudyRow {
  citekey: string;
  title: string | null;
  doi: string | null;
  pmid: string | null;
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

function registerBuiltInStageHandlers(orchestrator: PipelineOrchestrator, params: {
  db: BunSQLiteDatabase;
  config: RhizomeConfig;
  cwd: string;
}): void {
  orchestrator.registerStageHandler(PipelineStep.SUMMARIZE, async ({ job }) => {
    const study = loadStudyForSummarize(params.db, job.sissId);

    const summary = await runSummarizeStage({
      study: {
        citekey: study.citekey,
        title: study.title ?? "Untitled study",
        authors: [],
        year: new Date().getUTCFullYear(),
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
}

export async function runProcessCommand(
  options: ProcessCommandOptions,
  deps: ProcessCommandDeps = {},
): Promise<ProcessCommandResult> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;

  const configPath = join(cwd, ".siss", "config.yaml");
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
    });

    const aiMode = options.ai === true;
    const result = aiMode
      ? await orchestrator.processAI({ batchSize: options.batch })
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
