import { join } from "node:path";
import { loadConfig, type RhizomeConfig } from "../../config/loader";
import { resolveWorkspaceConfigPath } from "../../config/workspace-contract";
import { Database } from "../../db/database";
import { PipelineStep } from "../../types/pipeline";

const DEFAULT_LAST = 25;
const MAX_LAST = 200;

export interface AuditCommandOptions {
  citekey?: string;
  stage?: string;
  errors?: boolean;
  last?: number;
  json?: boolean;
}

export interface AuditFilters {
  citekey: string | null;
  stage: PipelineStep | null;
  errorsOnly: boolean;
  last: number;
}

export interface AuditRunRow {
  id: number;
  run_id: string;
  rhizome_id: string;
  citekey: string;
  step: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  retries: number;
  skip_reason: string | null;
  error: string | null;
  model: string | null;
  skill: string | null;
  created_at: string;
}

export interface AuditCommandResult {
  filters: AuditFilters;
  count: number;
  runs: AuditRunRow[];
}

export interface AuditCommandDeps {
  cwd?: string;
  stdout?: Pick<typeof process.stdout, "write">;
  loadConfigFn?: (configPath: string) => Promise<RhizomeConfig>;
}

interface StudyExistsRow {
  rhizome_id: string;
}

interface RawAuditRow {
  id: number;
  run_id: string;
  rhizome_id: string;
  citekey: string;
  step: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  retries: number | null;
  skip_reason: string | null;
  error: string | null;
  model: string | null;
  skill: string | null;
  created_at: string;
}

function resolveDbPath(cwd: string, config: RhizomeConfig): string {
  return join(cwd, config.data.db_path);
}

function normalizeCitekeyOption(citekey: string): string {
  const normalized = citekey.trim();
  if (normalized.length === 0) {
    throw new Error("--citekey requires a non-empty value");
  }
  return normalized;
}

function normalizeStageOption(stage: string | undefined): PipelineStep | null {
  if (typeof stage !== "string") {
    return null;
  }

  const normalized = stage.trim() as PipelineStep;
  if (!Object.values(PipelineStep).includes(normalized)) {
    throw new Error(`Unknown stage '${stage}'. Valid stages: ${Object.values(PipelineStep).join(", ")}`);
  }

  return normalized;
}

function normalizeLastOption(last: number | undefined): number {
  if (last === undefined) {
    return DEFAULT_LAST;
  }

  if (!Number.isFinite(last) || !Number.isInteger(last) || last <= 0) {
    throw new Error(`--last must be a positive integer between 1 and ${MAX_LAST}`);
  }

  return Math.min(last, MAX_LAST);
}

function normalizeFilters(options: AuditCommandOptions): AuditFilters {
  return {
    citekey: typeof options.citekey === "string" ? normalizeCitekeyOption(options.citekey) : null,
    stage: normalizeStageOption(options.stage),
    errorsOnly: options.errors === true,
    last: normalizeLastOption(options.last),
  };
}

function assertCitekeyExists(db: Database["db"], citekey: string): void {
  const row = db
    .query(
      `
      SELECT rhizome_id
      FROM studies
      WHERE citekey = ?
      LIMIT 1;
      `,
    )
    .get(citekey) as StudyExistsRow | null;

  if (!row) {
    throw new Error(`Study not found for citekey=${citekey}`);
  }
}

function renderResultText(result: AuditCommandResult): string {
  const filtersLine = [
    `citekey=${result.filters.citekey ?? "*"}`,
    `stage=${result.filters.stage ?? "*"}`,
    `errors=${result.filters.errorsOnly ? "true" : "false"}`,
    `last=${result.filters.last}`,
  ].join(", ");

  if (result.runs.length === 0) {
    return [`Audit history`, `Filters: ${filtersLine}`, `Rows: 0`, `(no matching runs)`, ""].join("\n");
  }

  const lines = result.runs.map((run) => {
    const base = `#${run.id} ${run.citekey} ${run.step} ${run.status} retries=${run.retries} run_id=${run.run_id}`;
    const timing = `  started=${run.started_at ?? "null"} completed=${run.completed_at ?? "null"} created=${run.created_at}`;
    const diagnostics = `  error=${run.error ?? "null"} skip_reason=${run.skip_reason ?? "null"} model=${run.model ?? "null"} skill=${run.skill ?? "null"}`;
    return `${base}\n${timing}\n${diagnostics}`;
  });

  return ["Audit history", `Filters: ${filtersLine}`, `Rows: ${result.count}`, ...lines, ""].join("\n");
}

export async function runAuditCommand(
  options: AuditCommandOptions,
  deps: AuditCommandDeps = {},
): Promise<AuditCommandResult> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;

  const filters = normalizeFilters(options);

  const configPath = await resolveWorkspaceConfigPath(cwd);
  const config = await (deps.loadConfigFn ?? loadConfig)(configPath);

  const database = new Database({ path: resolveDbPath(cwd, config) });
  database.init();

  try {
    if (filters.citekey) {
      assertCitekeyExists(database.db, filters.citekey);
    }

    const whereParts: string[] = [];
    const params: Array<string | number> = [];

    if (filters.citekey) {
      whereParts.push("s.citekey = ?");
      params.push(filters.citekey);
    }

    if (filters.stage) {
      whereParts.push("pr.step = ?");
      params.push(filters.stage);
    }

    if (filters.errorsOnly) {
      whereParts.push("(pr.status = 'failed' OR (pr.error IS NOT NULL AND TRIM(pr.error) <> ''))");
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    const rows = database.db
      .query(
        `
        SELECT
          pr.id,
          pr.run_id,
          pr.rhizome_id,
          s.citekey,
          pr.step,
          pr.status,
          pr.started_at,
          pr.completed_at,
          pr.retries,
          pr.skip_reason,
          pr.error,
          pr.model,
          pr.skill,
          pr.created_at
        FROM pipeline_runs pr
        INNER JOIN studies s ON s.rhizome_id = pr.rhizome_id
        ${whereSql}
        ORDER BY pr.id DESC
        LIMIT ?;
        `,
      )
      .all(...params, filters.last) as RawAuditRow[];

    const runs: AuditRunRow[] = rows.map((row) => ({
      id: Number(row.id),
      run_id: row.run_id,
      rhizome_id: row.rhizome_id,
      citekey: row.citekey,
      step: row.step,
      status: row.status,
      started_at: row.started_at ?? null,
      completed_at: row.completed_at ?? null,
      retries: Number(row.retries ?? 0),
      skip_reason: row.skip_reason ?? null,
      error: row.error ?? null,
      model: row.model ?? null,
      skill: row.skill ?? null,
      created_at: row.created_at,
    }));

    const result: AuditCommandResult = {
      filters,
      count: runs.length,
      runs,
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
