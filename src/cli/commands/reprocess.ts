import { join } from "node:path";
import { loadConfig, type RhizomeConfig } from "../../config/loader";
import { resolveWorkspaceConfigPath } from "../../config/workspace-contract";
import { Database } from "../../db/database";
import { WriterLock, WriterLockError } from "../../lock/writer-lock";
import { PipelineStep, type JobStatus } from "../../types/pipeline";

export interface ReprocessCommandOptions {
  citekey?: string;
  filter?: string;
  stage?: string;
  cascade?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface ReprocessCommandResult {
  selector: {
    mode: "citekey" | "filter";
    citekey?: string;
    filter?: string;
  };
  stage: PipelineStep;
  stages: PipelineStep[];
  cascade: boolean;
  dryRun: boolean;
  matchedStudies: number;
  matchedJobs: number;
  jobsRequeued: number;
  stageCounters: Record<PipelineStep, number>;
}

export interface ReprocessCommandDeps {
  cwd?: string;
  stdout?: Pick<typeof process.stdout, "write">;
  loadConfigFn?: (configPath: string) => Promise<RhizomeConfig>;
}

interface StudyRow {
  rhizome_id: string;
}

interface JobCandidateRow {
  id: number;
  stage: PipelineStep;
  status: JobStatus;
}

const MUTABLE_JOB_STATUSES: JobStatus[] = ["processing", "complete", "error", "paused", "skipped"];

const CASCADE_STAGES_BY_ORIGIN: Record<PipelineStep, PipelineStep[]> = {
  [PipelineStep.INGEST]: [PipelineStep.INGEST],
  [PipelineStep.ZOTERO_SYNC]: [PipelineStep.ZOTERO_SYNC],
  [PipelineStep.PDF_FETCH]: [
    PipelineStep.PDF_FETCH,
    PipelineStep.FULLTEXT_MARKER,
    PipelineStep.SUMMARIZE,
    PipelineStep.CLASSIFY,
    PipelineStep.VAULT_WRITE,
  ],
  [PipelineStep.FULLTEXT_MARKER]: [
    PipelineStep.FULLTEXT_MARKER,
    PipelineStep.SUMMARIZE,
    PipelineStep.CLASSIFY,
    PipelineStep.VAULT_WRITE,
  ],
  [PipelineStep.FULLTEXT_DOCLING]: [
    PipelineStep.FULLTEXT_DOCLING,
    PipelineStep.SUMMARIZE,
    PipelineStep.CLASSIFY,
    PipelineStep.VAULT_WRITE,
  ],
  [PipelineStep.SUMMARIZE]: [PipelineStep.SUMMARIZE, PipelineStep.CLASSIFY, PipelineStep.VAULT_WRITE],
  [PipelineStep.CLASSIFY]: [PipelineStep.CLASSIFY, PipelineStep.VAULT_WRITE],
  [PipelineStep.VAULT_WRITE]: [PipelineStep.VAULT_WRITE],
  [PipelineStep.BASES_SYNC]: [PipelineStep.BASES_SYNC],
};

function resolveDbPath(cwd: string, config: RhizomeConfig): string {
  return join(cwd, config.data.db_path);
}

function resolveLockPath(cwd: string, config: RhizomeConfig): string {
  return join(cwd, config.pipeline.lock_path);
}

function normalizeCitekeyOption(citekey: string): string {
  const normalized = citekey.trim();
  if (normalized.length === 0) {
    throw new Error("--citekey requires a non-empty value");
  }
  return normalized;
}

function normalizeStageOption(stage: string | undefined): PipelineStep {
  if (typeof stage !== "string") {
    throw new Error("--stage is required");
  }

  const normalized = stage.trim() as PipelineStep;
  if (!Object.values(PipelineStep).includes(normalized)) {
    throw new Error(
      `Unknown stage '${stage}'. Valid stages: ${Object.values(PipelineStep).join(", ")}`,
    );
  }

  return normalized;
}

function normalizeFilterOption(filter: string): string {
  const normalized = filter.trim();
  if (normalized.length === 0) {
    throw new Error("--filter requires a non-empty value");
  }

  return normalized;
}

function assertValidSelector(options: ReprocessCommandOptions): {
  mode: "citekey" | "filter";
  citekey?: string;
  filter?: string;
} {
  const hasCitekey = typeof options.citekey === "string";
  const hasFilter = typeof options.filter === "string";

  if (hasCitekey === hasFilter) {
    throw new Error("Select exactly one reprocess target: use either --citekey <key> or --filter <expr>");
  }

  if (hasCitekey) {
    return {
      mode: "citekey",
      citekey: normalizeCitekeyOption(options.citekey as string),
    };
  }

  return {
    mode: "filter",
    filter: normalizeFilterOption(options.filter as string),
  };
}

function resolveStages(stage: PipelineStep, cascade: boolean): PipelineStep[] {
  const chain = cascade ? CASCADE_STAGES_BY_ORIGIN[stage] : [stage];
  return [...new Set(chain)];
}

function renderFilterToStudySql(filter: string): { whereSql: string; params: string[] } {
  if (filter === "has_summary=false") {
    return {
      whereSql: `
        NOT EXISTS (
          SELECT 1
          FROM jobs j
          WHERE j.rhizome_id = studies.rhizome_id
            AND j.stage = '${PipelineStep.SUMMARIZE}'
            AND j.status = 'complete'
        )
      `,
      params: [],
    };
  }

  if (filter === "has_summary=true") {
    return {
      whereSql: `
        EXISTS (
          SELECT 1
          FROM jobs j
          WHERE j.rhizome_id = studies.rhizome_id
            AND j.stage = '${PipelineStep.SUMMARIZE}'
            AND j.status = 'complete'
        )
      `,
      params: [],
    };
  }

  if (filter === "pipeline_overall='needs_attention'" || filter === 'pipeline_overall = "needs_attention"') {
    return {
      whereSql: `studies.pipeline_overall = 'needs_attention'`,
      params: [],
    };
  }

  throw new Error(
    "Unsupported --filter expression. Supported values: has_summary=false, has_summary=true, pipeline_overall='needs_attention'",
  );
}

function findStudyIds(
  db: Database["db"],
  selector: { mode: "citekey" | "filter"; citekey?: string; filter?: string },
): string[] {
  if (selector.mode === "citekey") {
    const row = db
      .query(
        `
        SELECT rhizome_id
        FROM studies
        WHERE citekey = ?
        LIMIT 1;
        `,
      )
      .get(selector.citekey) as StudyRow | null;

    if (!row) {
      throw new Error(`Study not found for citekey=${selector.citekey}`);
    }

    return [row.rhizome_id];
  }

  const filterPlan = renderFilterToStudySql(selector.filter as string);
  const rows = db
    .query(
      `
      SELECT rhizome_id
      FROM studies
      WHERE ${filterPlan.whereSql}
      ORDER BY rhizome_id ASC;
      `,
    )
    .all(...filterPlan.params) as StudyRow[];

  return rows.map((row) => row.rhizome_id);
}

function buildRequeuePlan(
  db: Database["db"],
  studyIds: string[],
  stages: PipelineStep[],
): {
  matchedStudies: number;
  matchedJobs: number;
  jobIdsToRequeue: number[];
  stageCounters: Record<PipelineStep, number>;
} {
  const stageCounters = Object.fromEntries(
    Object.values(PipelineStep).map((stage) => [stage, 0]),
  ) as Record<PipelineStep, number>;

  if (studyIds.length === 0) {
    return {
      matchedStudies: 0,
      matchedJobs: 0,
      jobIdsToRequeue: [],
      stageCounters,
    };
  }

  const placeholdersStudy = studyIds.map(() => "?").join(", ");
  const placeholdersStage = stages.map(() => "?").join(", ");

  const candidates = db
    .query(
      `
      SELECT id, stage, status
      FROM jobs
      WHERE rhizome_id IN (${placeholdersStudy})
        AND stage IN (${placeholdersStage});
      `,
    )
    .all(...studyIds, ...stages) as JobCandidateRow[];

  const requeueRows = candidates.filter((row) => MUTABLE_JOB_STATUSES.includes(row.status));
  for (const row of requeueRows) {
    stageCounters[row.stage] += 1;
  }

  return {
    matchedStudies: studyIds.length,
    matchedJobs: candidates.length,
    jobIdsToRequeue: requeueRows.map((row) => row.id),
    stageCounters,
  };
}

function renderResultText(result: ReprocessCommandResult): string {
  const selectorText =
    result.selector.mode === "citekey"
      ? `Selector: citekey=${result.selector.citekey}`
      : `Selector: filter=${result.selector.filter}`;

  const modeText = result.dryRun ? "Mode: dry-run (no writes)" : "Mode: mutate";

  const stageLines = result.stages
    .map((stage) => `  ${stage}: ${result.stageCounters[stage] ?? 0}`)
    .join("\n");

  return [
    selectorText,
    `Stage: ${result.stage}`,
    `Cascade: ${result.cascade ? "enabled" : "disabled"}`,
    modeText,
    `Matched studies: ${result.matchedStudies}`,
    `Matched jobs (selected stages): ${result.matchedJobs}`,
    `${result.dryRun ? "Would requeue jobs" : "Requeued jobs"}: ${result.jobsRequeued}`,
    "Stage counters:",
    stageLines,
    "",
  ].join("\n");
}

export async function runReprocessCommand(
  options: ReprocessCommandOptions,
  deps: ReprocessCommandDeps = {},
): Promise<ReprocessCommandResult> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;

  const selector = assertValidSelector(options);
  const stage = normalizeStageOption(options.stage);
  const stages = resolveStages(stage, options.cascade === true);

  const configPath = await resolveWorkspaceConfigPath(cwd);
  const config = await (deps.loadConfigFn ?? loadConfig)(configPath);

  const database = new Database({ path: resolveDbPath(cwd, config) });
  database.init();

  if (options.dryRun === true) {
    try {
      const studyIds = findStudyIds(database.db, selector);
      const plan = buildRequeuePlan(database.db, studyIds, stages);

      const result: ReprocessCommandResult = {
        selector,
        stage,
        stages,
        cascade: options.cascade === true,
        dryRun: true,
        matchedStudies: plan.matchedStudies,
        matchedJobs: plan.matchedJobs,
        jobsRequeued: plan.jobIdsToRequeue.length,
        stageCounters: plan.stageCounters,
      };

      if (options.json) {
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        stdout.write(renderResultText(result));
      }

      return result;
    } finally {
      database.close();
    }
  }

  const lock = new WriterLock({
    lockPath: resolveLockPath(cwd, config),
    staleTimeoutMs: config.pipeline.lock_stale_minutes * 60 * 1000,
  });

  try {
    await lock.acquire(
      selector.mode === "citekey"
        ? `rhizome reprocess --citekey ${selector.citekey} --stage ${stage}${options.cascade ? " --cascade" : ""}`
        : `rhizome reprocess --filter ${selector.filter} --stage ${stage}${options.cascade ? " --cascade" : ""}`,
    );
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
    database.db.exec("BEGIN IMMEDIATE TRANSACTION;");

    try {
      const studyIds = findStudyIds(database.db, selector);
      const plan = buildRequeuePlan(database.db, studyIds, stages);

      if (plan.jobIdsToRequeue.length > 0) {
        const placeholders = plan.jobIdsToRequeue.map(() => "?").join(", ");
        database.db
          .query(
            `
            UPDATE jobs
            SET
              status = 'queued',
              error_message = NULL,
              error_class = NULL,
              started_at = NULL,
              completed_at = NULL
            WHERE id IN (${placeholders});
            `,
          )
          .run(...plan.jobIdsToRequeue);
      }

      database.db.exec("COMMIT;");

      const result: ReprocessCommandResult = {
        selector,
        stage,
        stages,
        cascade: options.cascade === true,
        dryRun: false,
        matchedStudies: plan.matchedStudies,
        matchedJobs: plan.matchedJobs,
        jobsRequeued: plan.jobIdsToRequeue.length,
        stageCounters: plan.stageCounters,
      };

      if (options.json) {
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        stdout.write(renderResultText(result));
      }

      return result;
    } catch (error) {
      database.db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    await lock.release();
    database.close();
  }
}
