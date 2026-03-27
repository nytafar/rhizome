import type { Database as BunSQLiteDatabase } from "bun:sqlite";
import { JobQueue, type QueueJob } from "../queue/job-queue";
import {
  PipelineOverallStatus,
  PipelineStep,
  PipelineStepStatus,
  type PipelineStepState,
} from "../types/pipeline";

export interface ProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  enqueued: number;
}

export interface ProcessAIOptions {
  batchSize?: number;
}

export interface PipelineOrchestratorEvent {
  type:
    | "job-processing"
    | "job-complete"
    | "job-failed"
    | "stage-enqueued"
    | "stage-handler-missing";
  sissId: string;
  stage: PipelineStep;
  detail?: string;
}

export interface StageExecutionResult {
  metadata?: Record<string, unknown>;
}

export type StageHandler = (context: {
  job: QueueJob;
  db: BunSQLiteDatabase;
  now: () => Date;
}) => Promise<StageExecutionResult | void>;

export interface PipelineOrchestratorOptions {
  db: BunSQLiteDatabase;
  queue?: JobQueue;
  handlers?: Partial<Record<PipelineStep, StageHandler>>;
  stageSequence?: PipelineStep[];
  aiStages?: Set<PipelineStep>;
  now?: () => Date;
  onEvent?: (event: PipelineOrchestratorEvent) => void;
}

interface StudyStateRow {
  pipeline_steps_json: string;
  pipeline_overall: PipelineOverallStatus;
  pipeline_error: string | null;
}

const DEFAULT_STAGE_SEQUENCE: PipelineStep[] = [
  PipelineStep.INGEST,
  PipelineStep.ZOTERO_SYNC,
  PipelineStep.PDF_FETCH,
  PipelineStep.FULLTEXT_MARKER,
  PipelineStep.SUMMARIZE,
  PipelineStep.VAULT_WRITE,
];

const DEFAULT_AI_STAGES = new Set<PipelineStep>([
  PipelineStep.SUMMARIZE,
  PipelineStep.CLASSIFY,
]);

const REQUIRED_PHASE1_STEPS: PipelineStep[] = [
  PipelineStep.INGEST,
  PipelineStep.ZOTERO_SYNC,
  PipelineStep.PDF_FETCH,
  PipelineStep.FULLTEXT_MARKER,
  PipelineStep.SUMMARIZE,
  PipelineStep.VAULT_WRITE,
];

export function derivePipelineOverall(
  pipelineSteps: Record<string, PipelineStepState>,
  requiredSteps: PipelineStep[] = REQUIRED_PHASE1_STEPS,
): PipelineOverallStatus {
  const stepStates = Object.values(pipelineSteps);

  if (stepStates.some((state) => state.status === PipelineStepStatus.FAILED || state.status === PipelineStepStatus.BLOCKED)) {
    return PipelineOverallStatus.NEEDS_ATTENTION;
  }

  const requiredComplete = requiredSteps.every((step) => {
    const status = pipelineSteps[step]?.status;
    return status === PipelineStepStatus.COMPLETE || status === PipelineStepStatus.SKIPPED;
  });

  if (requiredComplete) {
    return PipelineOverallStatus.COMPLETE;
  }

  const hasWorkInFlight = stepStates.some(
    (state) => state.status === PipelineStepStatus.QUEUED || state.status === PipelineStepStatus.PROCESSING,
  );
  const hasAnyCompleted = stepStates.some((state) => state.status === PipelineStepStatus.COMPLETE);

  if (hasWorkInFlight || hasAnyCompleted) {
    return PipelineOverallStatus.IN_PROGRESS;
  }

  return PipelineOverallStatus.NOT_STARTED;
}

export class PipelineOrchestrator {
  private readonly db: BunSQLiteDatabase;
  private readonly queue: JobQueue;
  private readonly handlers: Partial<Record<PipelineStep, StageHandler>>;
  private readonly stageSequence: PipelineStep[];
  private readonly aiStages: Set<PipelineStep>;
  private readonly now: () => Date;
  private readonly onEvent?: (event: PipelineOrchestratorEvent) => void;

  public constructor(options: PipelineOrchestratorOptions) {
    this.db = options.db;
    this.queue = options.queue ?? new JobQueue(options.db);
    this.handlers = { ...(options.handlers ?? {}) };
    this.stageSequence = options.stageSequence ?? DEFAULT_STAGE_SEQUENCE;
    this.aiStages = options.aiStages ?? DEFAULT_AI_STAGES;
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
  }

  public registerStageHandler(stage: PipelineStep, handler: StageHandler): void {
    this.handlers[stage] = handler;
  }

  public async processNonAI(): Promise<ProcessResult> {
    return this.processQueue({ ai: false });
  }

  public async processAI(options: ProcessAIOptions = {}): Promise<ProcessResult> {
    return this.processQueue({ ai: true, batchSize: options.batchSize });
  }

  private async processQueue(options: { ai: boolean; batchSize?: number }): Promise<ProcessResult> {
    const result: ProcessResult = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      enqueued: 0,
    };

    while (options.batchSize === undefined || result.processed < options.batchSize) {
      const nextJob = this.pickNextJob(options.ai);
      if (!nextJob) {
        break;
      }

      result.processed += 1;
      const didSucceed = await this.processJob(nextJob);

      if (didSucceed) {
        result.succeeded += 1;
        result.enqueued += this.enqueueNextStage(nextJob);
      } else {
        result.failed += 1;
      }
    }

    return result;
  }

  private pickNextJob(ai: boolean): QueueJob | null {
    const queuedJobs = this.queue.query({ status: "queued" });
    return (
      queuedJobs.find((job) => {
        const isAiStage = this.aiStages.has(job.stage);
        return ai ? isAiStage : !isAiStage;
      }) ?? null
    );
  }

  private async processJob(job: QueueJob): Promise<boolean> {
    const startedAtDate = this.now();
    const startedAt = startedAtDate.toISOString();
    const handler = this.handlers[job.stage];

    this.queue.updateStatus({
      jobId: job.id,
      status: "processing",
      startedAt,
    });

    this.updateStudyStageStatus({
      sissId: job.sissId,
      stage: job.stage,
      status: PipelineStepStatus.PROCESSING,
      updatedAt: startedAt,
      retries: job.retryCount,
      error: null,
    });

    this.onEvent?.({
      type: "job-processing",
      sissId: job.sissId,
      stage: job.stage,
    });

    if (!handler) {
      const completedAt = this.now().toISOString();
      this.queue.updateStatus({
        jobId: job.id,
        status: "error",
        completedAt,
        errorMessage: `No handler registered for stage: ${job.stage}`,
        errorClass: "permanent",
        incrementRetryCount: true,
      });

      this.updateStudyStageStatus({
        sissId: job.sissId,
        stage: job.stage,
        status: PipelineStepStatus.FAILED,
        updatedAt: completedAt,
        retries: job.retryCount + 1,
        error: `No handler registered for stage: ${job.stage}`,
      });

      this.onEvent?.({
        type: "stage-handler-missing",
        sissId: job.sissId,
        stage: job.stage,
      });

      return false;
    }

    try {
      const stageResult = await handler({
        job,
        db: this.db,
        now: this.now,
      });

      const completedAtDate = this.now();
      const completedAt = completedAtDate.toISOString();
      const durationMs = Math.max(0, completedAtDate.getTime() - startedAtDate.getTime());

      this.queue.updateStatus({
        jobId: job.id,
        status: "complete",
        completedAt,
        errorMessage: null,
        errorClass: null,
        metadata: stageResult?.metadata ? JSON.stringify(stageResult.metadata) : undefined,
      });

      this.updateStudyStageStatus({
        sissId: job.sissId,
        stage: job.stage,
        status: PipelineStepStatus.COMPLETE,
        updatedAt: completedAt,
        retries: job.retryCount,
        durationMs,
        error: null,
      });

      this.onEvent?.({
        type: "job-complete",
        sissId: job.sissId,
        stage: job.stage,
      });

      return true;
    } catch (error) {
      const completedAt = this.now().toISOString();
      const message = error instanceof Error ? error.message : String(error);

      this.queue.updateStatus({
        jobId: job.id,
        status: "error",
        completedAt,
        errorMessage: message,
        errorClass: "transient",
        incrementRetryCount: true,
      });

      this.updateStudyStageStatus({
        sissId: job.sissId,
        stage: job.stage,
        status: PipelineStepStatus.FAILED,
        updatedAt: completedAt,
        retries: job.retryCount + 1,
        error: message,
      });

      this.onEvent?.({
        type: "job-failed",
        sissId: job.sissId,
        stage: job.stage,
        detail: message,
      });

      return false;
    }
  }

  private enqueueNextStage(job: QueueJob): number {
    const currentIndex = this.stageSequence.indexOf(job.stage);
    if (currentIndex === -1 || currentIndex === this.stageSequence.length - 1) {
      return 0;
    }

    const nextStage = this.stageSequence[currentIndex + 1];
    if (!nextStage) {
      return 0;
    }

    const existing = this.queue
      .query({ sissId: job.sissId, stage: nextStage })
      .find((candidate) => candidate.status === "queued" || candidate.status === "processing");

    if (existing) {
      return 0;
    }

    this.queue.enqueue({
      sissId: job.sissId,
      stage: nextStage,
      status: "queued",
      aiWindowRequired: this.aiStages.has(nextStage),
    });

    this.updateStudyStageStatus({
      sissId: job.sissId,
      stage: nextStage,
      status: PipelineStepStatus.QUEUED,
      updatedAt: this.now().toISOString(),
      retries: 0,
      error: null,
    });

    this.onEvent?.({
      type: "stage-enqueued",
      sissId: job.sissId,
      stage: nextStage,
    });

    return 1;
  }

  private updateStudyStageStatus(params: {
    sissId: string;
    stage: PipelineStep;
    status: PipelineStepStatus;
    updatedAt: string;
    retries: number;
    error: string | null;
    durationMs?: number;
  }): void {
    const state = this.readStudyState(params.sissId);

    const pipelineSteps = this.parsePipelineSteps(state.pipeline_steps_json);
    pipelineSteps[params.stage] = {
      ...(pipelineSteps[params.stage] ?? {}),
      status: params.status,
      updated_at: params.updatedAt,
      retries: params.retries,
      ...(params.durationMs !== undefined ? { duration_ms: params.durationMs } : {}),
      ...(params.error ? { error: params.error } : {}),
    } as PipelineStepState;

    if (!params.error && pipelineSteps[params.stage]?.error) {
      delete (pipelineSteps[params.stage] as Partial<PipelineStepState>).error;
    }

    const overall = derivePipelineOverall(pipelineSteps);

    this.db
      .query(
        `
        UPDATE studies
        SET pipeline_steps_json = ?, pipeline_overall = ?, pipeline_error = ?, updated_at = ?
        WHERE siss_id = ?;
        `,
      )
      .run(
        JSON.stringify(pipelineSteps),
        overall,
        params.error,
        params.updatedAt,
        params.sissId,
      );
  }

  private readStudyState(sissId: string): StudyStateRow {
    const row = this.db
      .query(
        `
        SELECT pipeline_steps_json, pipeline_overall, pipeline_error
        FROM studies
        WHERE siss_id = ?
        LIMIT 1;
        `,
      )
      .get(sissId) as StudyStateRow | null;

    if (!row) {
      throw new Error(`Study not found for siss_id=${sissId}`);
    }

    return row;
  }

  private parsePipelineSteps(raw: string): Record<string, PipelineStepState> {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, PipelineStepState>;
      }
    } catch {
      // ignore malformed state and rebuild fresh object.
    }

    return {};
  }
}
