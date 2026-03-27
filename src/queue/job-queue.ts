import type { Database as BunSQLiteDatabase, Statement } from "bun:sqlite";
import type { JobStatus, PipelineStep } from "../types/pipeline";

const KEEP_SENTINEL = "__KEEP__";

export interface EnqueueJobInput {
  rhizomeId: string;
  stage: PipelineStep;
  priority?: number;
  status?: JobStatus;
  aiWindowRequired?: boolean;
  maxRetries?: number;
  metadata?: string | null;
}

export interface QueueJob {
  id: number;
  rhizomeId: string;
  stage: PipelineStep;
  status: JobStatus;
  priority: number;
  aiWindowRequired: boolean;
  errorMessage: string | null;
  errorClass: string | null;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  metadata: string | null;
}

export interface UpdateJobStatusInput {
  jobId: number;
  status: JobStatus;
  errorMessage?: string | null;
  errorClass?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  metadata?: string | null;
  incrementRetryCount?: boolean;
}

export interface JobQueryFilters {
  rhizomeId?: string;
  stage?: PipelineStep;
  status?: JobStatus;
  readyOnly?: boolean;
  atTime?: Date | string;
}

export interface RecordStageLogInput {
  rhizomeId: string;
  stage: PipelineStep;
  status: "started" | "completed" | "failed" | "skipped";
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  metadata?: string | null;
}

export interface RecordPipelineRunInput {
  rhizomeId: string;
  runId: string;
  step: PipelineStep;
  status: "started" | "completed" | "failed" | "skipped";
  startedAt?: string | null;
  completedAt?: string | null;
  retries?: number;
  skipReason?: string | null;
  error?: string | null;
  model?: string | null;
  skill?: string | null;
}

type RawQueueJob = {
  id: number;
  rhizome_id: string;
  stage: PipelineStep;
  status: JobStatus;
  priority: number;
  ai_window_required: number;
  error_message: string | null;
  error_class: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata: string | null;
};

export class JobQueue {
  private readonly enqueueStmt: Statement;
  private readonly dequeueStmt: Statement;
  private readonly updateStatusStmt: Statement;
  private readonly queryJobsStmt: Statement;
  private readonly recordStageLogStmt: Statement;
  private readonly recordPipelineRunStmt: Statement;

  public constructor(private readonly db: BunSQLiteDatabase) {
    this.enqueueStmt = this.db.query(
      `
      INSERT INTO jobs (rhizome_id, stage, status, priority, ai_window_required, max_retries, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?);
      `,
    );

    this.dequeueStmt = this.db.query(
      `
      SELECT id, rhizome_id, stage, status, priority, ai_window_required, error_message, error_class,
             retry_count, max_retries, created_at, started_at, completed_at, metadata
      FROM jobs
      WHERE status = 'queued'
      ORDER BY priority DESC, created_at ASC, id ASC;
      `,
    );

    this.updateStatusStmt = this.db.query(
      `
      UPDATE jobs
      SET
        status = ?,
        error_message = CASE WHEN ? = '${KEEP_SENTINEL}' THEN error_message ELSE ? END,
        error_class = CASE WHEN ? = '${KEEP_SENTINEL}' THEN error_class ELSE ? END,
        started_at = CASE WHEN ? = '${KEEP_SENTINEL}' THEN started_at ELSE ? END,
        completed_at = CASE WHEN ? = '${KEEP_SENTINEL}' THEN completed_at ELSE ? END,
        retry_count = retry_count + ?,
        metadata = CASE WHEN ? = '${KEEP_SENTINEL}' THEN metadata ELSE ? END
      WHERE id = ?;
      `,
    );

    this.queryJobsStmt = this.db.query(
      `
      SELECT id, rhizome_id, stage, status, priority, ai_window_required, error_message, error_class,
             retry_count, max_retries, created_at, started_at, completed_at, metadata
      FROM jobs
      WHERE (?1 IS NULL OR rhizome_id = ?1)
        AND (?2 IS NULL OR stage = ?2)
        AND (?3 IS NULL OR status = ?3)
      ORDER BY priority DESC, created_at ASC, id ASC;
      `,
    );

    this.recordStageLogStmt = this.db.query(
      `
      INSERT INTO job_stage_log (rhizome_id, stage, status, started_at, completed_at, duration_ms, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?);
      `,
    );

    this.recordPipelineRunStmt = this.db.query(
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
    );
  }

  public enqueue(input: EnqueueJobInput): number {
    const status: JobStatus = input.status ?? "queued";
    const priority = input.priority ?? 0;
    const aiWindowRequired = input.aiWindowRequired ? 1 : 0;
    const maxRetries = input.maxRetries ?? 3;

    const result = this.enqueueStmt.run(
      input.rhizomeId,
      input.stage,
      status,
      priority,
      aiWindowRequired,
      maxRetries,
      input.metadata ?? null,
    ) as { lastInsertRowid: number | bigint };

    return Number(result.lastInsertRowid);
  }

  public dequeue(): QueueJob | null {
    const rows = this.dequeueStmt.all() as RawQueueJob[];
    const jobs = rows.map((row) => this.toQueueJob(row));
    return jobs.find((job) => this.isRetryEligible(job)) ?? null;
  }

  public updateStatus(input: UpdateJobStatusInput): void {
    this.updateStatusStmt.run(
      input.status,
      this.toPatchArg(input.errorMessage),
      input.errorMessage ?? null,
      this.toPatchArg(input.errorClass),
      input.errorClass ?? null,
      this.toPatchArg(input.startedAt),
      input.startedAt ?? null,
      this.toPatchArg(input.completedAt),
      input.completedAt ?? null,
      input.incrementRetryCount ? 1 : 0,
      this.toPatchArg(input.metadata),
      input.metadata ?? null,
      input.jobId,
    );
  }

  public query(filters: JobQueryFilters): QueueJob[] {
    const rows = this.queryJobsStmt.all(
      filters.rhizomeId ?? null,
      filters.stage ?? null,
      filters.status ?? null,
    ) as RawQueueJob[];

    const jobs = rows.map((row) => this.toQueueJob(row));
    if (!filters.readyOnly) {
      return jobs;
    }

    const at = filters.atTime ?? new Date();
    return jobs.filter((job) => this.isRetryEligible(job, at));
  }

  public recordStageLog(input: RecordStageLogInput): number {
    const result = this.recordStageLogStmt.run(
      input.rhizomeId,
      input.stage,
      input.status,
      input.startedAt ?? null,
      input.completedAt ?? null,
      input.durationMs ?? null,
      input.metadata ?? null,
    ) as { lastInsertRowid: number | bigint };

    return Number(result.lastInsertRowid);
  }

  public recordPipelineRun(input: RecordPipelineRunInput): number {
    const result = this.recordPipelineRunStmt.run(
      input.rhizomeId,
      input.runId,
      input.step,
      input.status,
      input.startedAt ?? null,
      input.completedAt ?? null,
      input.retries ?? 0,
      input.skipReason ?? null,
      input.error ?? null,
      input.model ?? null,
      input.skill ?? null,
    ) as { lastInsertRowid: number | bigint };

    return Number(result.lastInsertRowid);
  }

  private toPatchArg(value: string | null | undefined): string | null {
    return value === undefined ? KEEP_SENTINEL : value;
  }

  private isRetryEligible(job: QueueJob, atTime: Date | string = new Date()): boolean {
    if (job.status !== "queued") {
      return false;
    }

    const metadata = this.parseMetadata(job.metadata);
    const nextAttemptRaw = metadata?.next_attempt_at;
    if (typeof nextAttemptRaw !== "string" || nextAttemptRaw.trim().length === 0) {
      return true;
    }

    const nextAttemptMs = Date.parse(nextAttemptRaw);
    if (Number.isNaN(nextAttemptMs)) {
      return true;
    }

    const atMs = typeof atTime === "string" ? Date.parse(atTime) : atTime.getTime();
    if (Number.isNaN(atMs)) {
      return true;
    }

    return nextAttemptMs <= atMs;
  }

  private parseMetadata(metadata: string | null): Record<string, unknown> | null {
    if (!metadata) {
      return null;
    }

    try {
      const parsed = JSON.parse(metadata) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }

      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private toQueueJob(row: RawQueueJob): QueueJob {
    return {
      id: row.id,
      rhizomeId: row.rhizome_id,
      stage: row.stage,
      status: row.status,
      priority: row.priority,
      aiWindowRequired: row.ai_window_required === 1,
      errorMessage: row.error_message,
      errorClass: row.error_class,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      metadata: row.metadata,
    };
  }
}
