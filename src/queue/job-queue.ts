import type { Database as BunSQLiteDatabase, Statement } from "bun:sqlite";
import type { JobStatus, PipelineStep } from "../types/pipeline";

const KEEP_SENTINEL = "__KEEP__";

export interface EnqueueJobInput {
  sissId: string;
  stage: PipelineStep;
  priority?: number;
  status?: JobStatus;
  aiWindowRequired?: boolean;
  maxRetries?: number;
  metadata?: string | null;
}

export interface QueueJob {
  id: number;
  sissId: string;
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
  sissId?: string;
  stage?: PipelineStep;
  status?: JobStatus;
}

export interface RecordStageLogInput {
  sissId: string;
  stage: PipelineStep;
  status: "started" | "completed" | "failed" | "skipped";
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  metadata?: string | null;
}

type RawQueueJob = {
  id: number;
  siss_id: string;
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

  public constructor(private readonly db: BunSQLiteDatabase) {
    this.enqueueStmt = this.db.query(
      `
      INSERT INTO jobs (siss_id, stage, status, priority, ai_window_required, max_retries, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?);
      `,
    );

    this.dequeueStmt = this.db.query(
      `
      SELECT id, siss_id, stage, status, priority, ai_window_required, error_message, error_class,
             retry_count, max_retries, created_at, started_at, completed_at, metadata
      FROM jobs
      WHERE status = 'queued'
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT 1;
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
      SELECT id, siss_id, stage, status, priority, ai_window_required, error_message, error_class,
             retry_count, max_retries, created_at, started_at, completed_at, metadata
      FROM jobs
      WHERE (?1 IS NULL OR siss_id = ?1)
        AND (?2 IS NULL OR stage = ?2)
        AND (?3 IS NULL OR status = ?3)
      ORDER BY priority DESC, created_at ASC, id ASC;
      `,
    );

    this.recordStageLogStmt = this.db.query(
      `
      INSERT INTO job_stage_log (siss_id, stage, status, started_at, completed_at, duration_ms, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?);
      `,
    );
  }

  public enqueue(input: EnqueueJobInput): number {
    const status: JobStatus = input.status ?? "queued";
    const priority = input.priority ?? 0;
    const aiWindowRequired = input.aiWindowRequired ? 1 : 0;
    const maxRetries = input.maxRetries ?? 3;

    const result = this.enqueueStmt.run(
      input.sissId,
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
    const row = this.dequeueStmt.get() as RawQueueJob | null;
    return row ? this.toQueueJob(row) : null;
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
      filters.sissId ?? null,
      filters.stage ?? null,
      filters.status ?? null,
    ) as RawQueueJob[];

    return rows.map((row) => this.toQueueJob(row));
  }

  public recordStageLog(input: RecordStageLogInput): number {
    const result = this.recordStageLogStmt.run(
      input.sissId,
      input.stage,
      input.status,
      input.startedAt ?? null,
      input.completedAt ?? null,
      input.durationMs ?? null,
      input.metadata ?? null,
    ) as { lastInsertRowid: number | bigint };

    return Number(result.lastInsertRowid);
  }

  private toPatchArg(value: string | null | undefined): string {
    return value === undefined ? KEEP_SENTINEL : value;
  }

  private toQueueJob(row: RawQueueJob): QueueJob {
    return {
      id: row.id,
      sissId: row.siss_id,
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
