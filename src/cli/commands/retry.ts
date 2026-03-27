import { join } from "node:path";
import { loadConfig, type RhizomeConfig } from "../../config/loader";
import { resolveWorkspaceConfigPath } from "../../config/workspace-contract";
import { Database } from "../../db/database";
import { WriterLock, WriterLockError } from "../../lock/writer-lock";

export interface RetryCommandOptions {
  citekey?: string;
  allFailed?: boolean;
  resetRetries?: boolean;
  json?: boolean;
}

export interface RetryCommandResult {
  selector: {
    mode: "citekey" | "all_failed";
    citekey?: string;
  };
  resetRetries: boolean;
  studiesMatched: number;
  jobsRetried: number;
  retriedByStatus: {
    error: number;
    paused: number;
  };
}

export interface RetryCommandDeps {
  cwd?: string;
  stdout?: Pick<typeof process.stdout, "write">;
  loadConfigFn?: (configPath: string) => Promise<RhizomeConfig>;
}

interface StudySelectorRow {
  rhizome_id: string;
}

interface CountRow {
  count: number;
}

interface JobStatusCountRow {
  status: string;
  count: number;
}

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

function assertValidSelector(options: RetryCommandOptions): {
  mode: "citekey" | "all_failed";
  citekey?: string;
} {
  const hasCitekey = typeof options.citekey === "string";
  const hasAllFailed = options.allFailed === true;

  if (hasCitekey === hasAllFailed) {
    throw new Error("Select exactly one retry target: use either --citekey <key> or --all-failed");
  }

  if (hasCitekey) {
    return {
      mode: "citekey",
      citekey: normalizeCitekeyOption(options.citekey as string),
    };
  }

  return { mode: "all_failed" };
}

function clearRetryBlockingFields(rawMetadata: string | null): string | null {
  if (!rawMetadata) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawMetadata) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const metadata = { ...(parsed as Record<string, unknown>) };
    delete metadata.next_attempt_at;
    delete metadata.pause_reason;

    return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
  } catch {
    return null;
  }
}

function renderResultText(result: RetryCommandResult): string {
  const selectorText =
    result.selector.mode === "citekey"
      ? `Selector: citekey=${result.selector.citekey}`
      : "Selector: all failed jobs";

  if (result.studiesMatched === 0) {
    return `${selectorText}\nNo matching studies found; no jobs retried.\n`;
  }

  if (result.jobsRetried === 0) {
    return `${selectorText}\nNo retry-eligible jobs found (statuses: error/paused); no changes made.\n`;
  }

  return [
    selectorText,
    `Retried jobs: ${result.jobsRetried}`,
    `  error -> queued: ${result.retriedByStatus.error}`,
    `  paused -> queued: ${result.retriedByStatus.paused}`,
    `Studies touched: ${result.studiesMatched}`,
    `Retry counters reset: ${result.resetRetries ? "yes" : "no"}`,
    "",
  ].join("\n");
}

export async function runRetryCommand(
  options: RetryCommandOptions,
  deps: RetryCommandDeps = {},
): Promise<RetryCommandResult> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;

  const selector = assertValidSelector(options);

  const configPath = await resolveWorkspaceConfigPath(cwd);
  const config = await (deps.loadConfigFn ?? loadConfig)(configPath);

  const database = new Database({ path: resolveDbPath(cwd, config) });
  database.init();

  const lock = new WriterLock({
    lockPath: resolveLockPath(cwd, config),
    staleTimeoutMs: config.pipeline.lock_stale_minutes * 60 * 1000,
  });

  try {
    await lock.acquire(
      selector.mode === "citekey"
        ? `rhizome retry --citekey ${selector.citekey}`
        : "rhizome retry --all-failed",
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
    const retriedByStatus = { error: 0, paused: 0 };
    let studiesMatched = 0;
    let jobsRetried = 0;

    database.db.exec("BEGIN IMMEDIATE TRANSACTION;");

    try {
      if (selector.mode === "citekey") {
        const study = database.db
          .query(
            `
            SELECT rhizome_id
            FROM studies
            WHERE citekey = ?
            LIMIT 1;
            `,
          )
          .get(selector.citekey) as StudySelectorRow | null;

        if (!study) {
          throw new Error(`Study not found for citekey=${selector.citekey}`);
        }

        studiesMatched = 1;

        const statusCounts = database.db
          .query(
            `
            SELECT status, COUNT(*) AS count
            FROM jobs
            WHERE rhizome_id = ?
              AND status IN ('error', 'paused')
            GROUP BY status;
            `,
          )
          .all(study.rhizome_id) as JobStatusCountRow[];

        for (const row of statusCounts) {
          if (row.status === "error") {
            retriedByStatus.error = Number(row.count);
          } else if (row.status === "paused") {
            retriedByStatus.paused = Number(row.count);
          }
        }

        const retryableRows = database.db
          .query(
            `
            SELECT id, metadata
            FROM jobs
            WHERE rhizome_id = ?
              AND status IN ('error', 'paused');
            `,
          )
          .all(study.rhizome_id) as Array<{ id: number; metadata: string | null }>;

        const updateStmt = database.db.query(
          `
          UPDATE jobs
          SET
            status = 'queued',
            error_message = NULL,
            error_class = NULL,
            started_at = NULL,
            completed_at = NULL,
            retry_count = CASE WHEN ? THEN 0 ELSE retry_count END,
            metadata = ?
          WHERE id = ?;
          `,
        );

        for (const row of retryableRows) {
          updateStmt.run(options.resetRetries === true, clearRetryBlockingFields(row.metadata), row.id);
        }

        jobsRetried = retryableRows.length;
      } else {
        const statusCounts = database.db
          .query(
            `
            SELECT status, COUNT(*) AS count
            FROM jobs
            WHERE status IN ('error', 'paused')
            GROUP BY status;
            `,
          )
          .all() as JobStatusCountRow[];

        for (const row of statusCounts) {
          if (row.status === "error") {
            retriedByStatus.error = Number(row.count);
          } else if (row.status === "paused") {
            retriedByStatus.paused = Number(row.count);
          }
        }

        jobsRetried = retriedByStatus.error + retriedByStatus.paused;

        const touchedStudyRow = database.db
          .query(
            `
            SELECT COUNT(DISTINCT rhizome_id) AS count
            FROM jobs
            WHERE status IN ('error', 'paused');
            `,
          )
          .get() as CountRow;
        studiesMatched = Number(touchedStudyRow.count);

        const retryableRows = database.db
          .query(
            `
            SELECT id, metadata
            FROM jobs
            WHERE status IN ('error', 'paused');
            `,
          )
          .all() as Array<{ id: number; metadata: string | null }>;

        const updateStmt = database.db.query(
          `
          UPDATE jobs
          SET
            status = 'queued',
            error_message = NULL,
            error_class = NULL,
            started_at = NULL,
            completed_at = NULL,
            retry_count = CASE WHEN ? THEN 0 ELSE retry_count END,
            metadata = ?
          WHERE id = ?;
          `,
        );

        for (const row of retryableRows) {
          updateStmt.run(options.resetRetries === true, clearRetryBlockingFields(row.metadata), row.id);
        }
      }

      database.db.exec("COMMIT;");
    } catch (error) {
      database.db.exec("ROLLBACK;");
      throw error;
    }

    const result: RetryCommandResult = {
      selector,
      resetRetries: options.resetRetries === true,
      studiesMatched,
      jobsRetried,
      retriedByStatus,
    };

    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(renderResultText(result));
    }

    return result;
  } finally {
    await lock.release();
    database.close();
  }
}
