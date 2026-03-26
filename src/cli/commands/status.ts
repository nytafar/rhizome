import { join } from "node:path";
import { loadConfig, type RhizomeConfig } from "../../config/loader";
import { resolveWorkspaceConfigPath } from "../../config/workspace-contract";
import { Database } from "../../db/database";

interface QueueCountRow {
  stage: string;
  status: string;
  count: number;
}

interface StudyRow {
  rhizome_id: string;
  citekey: string;
  title: string | null;
  pipeline_overall: string;
  pipeline_error: string | null;
  pipeline_steps_json: string;
}

export interface StatusCommandOptions {
  citekey?: string;
  json?: boolean;
}

export interface StatusOverview {
  queue: Record<string, number>;
  totals: {
    studies: number;
    jobs: number;
  };
}

export interface StatusStudyDetail {
  rhizome_id: string;
  citekey: string;
  title: string | null;
  pipeline_overall: string;
  pipeline_error: string | null;
  pipeline_steps: Record<string, unknown>;
}

export interface StatusCommandResult {
  mode: "overview" | "study";
  overview?: StatusOverview;
  study?: StatusStudyDetail;
}

export interface StatusCommandDeps {
  cwd?: string;
  stdout?: Pick<typeof process.stdout, "write">;
  loadConfigFn?: (configPath: string) => Promise<RhizomeConfig>;
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

function parseSteps(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function renderOverviewText(overview: StatusOverview): string {
  const queueLines = Object.entries(overview.queue)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `  ${key}: ${count}`);

  const queueBlock = queueLines.length > 0 ? queueLines.join("\n") : "  (no queued/processing/error jobs)";

  return [
    "Pipeline status overview",
    `Studies: ${overview.totals.studies}`,
    `Jobs: ${overview.totals.jobs}`,
    "Queue:",
    queueBlock,
    "",
  ].join("\n");
}

function renderStudyText(study: StatusStudyDetail): string {
  const steps = Object.entries(study.pipeline_steps)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([step, state]) => `  ${step}: ${JSON.stringify(state)}`)
    .join("\n");

  return [
    `Study ${study.citekey}`,
    `RHIZOME ID: ${study.rhizome_id}`,
    `Title: ${study.title ?? "(untitled)"}`,
    `Overall: ${study.pipeline_overall}`,
    `Error: ${study.pipeline_error ?? "none"}`,
    "Steps:",
    steps || "  (no steps)",
    "",
  ].join("\n");
}

export async function runStatusCommand(
  options: StatusCommandOptions,
  deps: StatusCommandDeps = {},
): Promise<StatusCommandResult> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;

  const configPath = await resolveWorkspaceConfigPath(cwd);
  const config = await (deps.loadConfigFn ?? loadConfig)(configPath);

  const database = new Database({ path: resolveDbPath(cwd, config) });
  database.init();

  try {
    if (typeof options.citekey === "string") {
      const normalizedCitekey = normalizeCitekeyOption(options.citekey);
      const row = database.db
        .query(
          `
          SELECT rhizome_id AS rhizome_id, citekey, title, pipeline_overall, pipeline_error, pipeline_steps_json
          FROM studies
          WHERE citekey = ?
          LIMIT 1;
          `,
        )
        .get(normalizedCitekey) as StudyRow | null;

      if (!row) {
        throw new Error(`Study not found for citekey=${normalizedCitekey}`);
      }

      const study: StatusStudyDetail = {
        rhizome_id: row.rhizome_id,
        citekey: row.citekey,
        title: row.title,
        pipeline_overall: row.pipeline_overall,
        pipeline_error: row.pipeline_error,
        pipeline_steps: parseSteps(row.pipeline_steps_json),
      };

      if (options.json) {
        stdout.write(`${JSON.stringify(study, null, 2)}\n`);
      } else {
        stdout.write(renderStudyText(study));
      }

      return {
        mode: "study",
        study,
      };
    }

    const queueRows = database.db
      .query(
        `
        SELECT stage, status, COUNT(*) as count
        FROM jobs
        GROUP BY stage, status;
        `,
      )
      .all() as QueueCountRow[];

    const queue = Object.fromEntries(
      queueRows
        .map((row) => [`${row.stage}.${row.status}`, Number(row.count)] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );

    const studyCount = database.db
      .query("SELECT COUNT(*) as count FROM studies;")
      .get() as { count: number };

    const jobCount = database.db
      .query("SELECT COUNT(*) as count FROM jobs;")
      .get() as { count: number };

    const overview: StatusOverview = {
      queue,
      totals: {
        studies: Number(studyCount.count),
        jobs: Number(jobCount.count),
      },
    };

    if (options.json) {
      stdout.write(`${JSON.stringify(overview, null, 2)}\n`);
    } else {
      stdout.write(renderOverviewText(overview));
    }

    return {
      mode: "overview",
      overview,
    };
  } finally {
    database.close();
  }
}
