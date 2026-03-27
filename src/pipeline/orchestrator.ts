import type { Database as BunSQLiteDatabase } from "bun:sqlite";
import { JobQueue, type QueueJob } from "../queue/job-queue";
import { evaluateAiWindows, type EvaluateAiWindowsResult } from "./ai-window";
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
  windows: string[];
  timezone: string;
  cooldownSeconds?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ProcessQueueOptions {
  ai: boolean;
  batchSize?: number;
  windows?: string[];
  timezone?: string;
  cooldownSeconds: number;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface PipelineOrchestratorEvent {
  type:
    | "job-processing"
    | "job-complete"
    | "job-failed"
    | "stage-enqueued"
    | "stage-handler-missing";
  rhizomeId: string;
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
  targetRhizomeId?: string;
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

const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 15 * 60_000;

type FailureClassification = "transient" | "permanent";

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
  private readonly targetRhizomeId?: string;
  private readonly onEvent?: (event: PipelineOrchestratorEvent) => void;

  public constructor(options: PipelineOrchestratorOptions) {
    this.db = options.db;
    this.queue = options.queue ?? new JobQueue(options.db);
    this.handlers = { ...(options.handlers ?? {}) };
    this.stageSequence = options.stageSequence ?? DEFAULT_STAGE_SEQUENCE;
    this.aiStages = options.aiStages ?? DEFAULT_AI_STAGES;
    this.targetRhizomeId = options.targetRhizomeId;
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
  }

  public registerStageHandler(stage: PipelineStep, handler: StageHandler): void {
    this.handlers[stage] = handler;
  }

  public async processNonAI(): Promise<ProcessResult> {
    return this.processQueue({
      ai: false,
      cooldownSeconds: 0,
      sleep: defaultSleep,
    });
  }

  public async processAI(options: ProcessAIOptions): Promise<ProcessResult> {
    return this.processQueue({
      ai: true,
      batchSize: options.batchSize,
      windows: options.windows,
      timezone: options.timezone,
      cooldownSeconds: options.cooldownSeconds ?? 0,
      sleep: options.sleep ?? defaultSleep,
    });
  }

  private async processQueue(options: ProcessQueueOptions): Promise<ProcessResult> {
    const result: ProcessResult = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      enqueued: 0,
    };

    const runId = this.buildRunId();
    const cooldownMilliseconds = Math.max(0, options.cooldownSeconds * 1_000);

    while (options.batchSize === undefined || result.processed < options.batchSize) {
      if (options.ai) {
        const windowState = this.evaluateAiWindowState(options);
        if (!windowState.active) {
          break;
        }
      }

      const nextJob = this.pickNextJob(options.ai);
      if (!nextJob) {
        break;
      }

      result.processed += 1;
      const didSucceed = await this.processJob(nextJob, runId);

      if (didSucceed) {
        result.succeeded += 1;
        result.enqueued += this.enqueueNextStage(nextJob);

        if (options.ai && cooldownMilliseconds > 0) {
          const hasRemainingBatchCapacity = options.batchSize === undefined || result.processed < options.batchSize;
          const hasQueuedAiWork = this.pickNextJob(true) !== null;

          if (hasRemainingBatchCapacity && hasQueuedAiWork) {
            const windowState = this.evaluateAiWindowState(options);
            if (!windowState.active) {
              break;
            }

            await options.sleep(cooldownMilliseconds);
          }
        }
      } else {
        result.failed += 1;
      }
    }

    return result;
  }

  private evaluateAiWindowState(options: ProcessQueueOptions): EvaluateAiWindowsResult & { ok: true } {
    if (!options.ai) {
      return {
        ok: true,
        active: true,
        localMinutes: 0,
        localTime: "00:00",
        parsedWindows: [],
      };
    }

    const windows = options.windows ?? [];
    const timezone = options.timezone ?? "";
    const evaluation = evaluateAiWindows({
      windows,
      timezone,
      now: this.now(),
    });

    if (!evaluation.ok) {
      throw new Error(`Invalid AI window configuration: ${evaluation.error.message}`);
    }

    return evaluation;
  }

  private pickNextJob(ai: boolean): QueueJob | null {
    const queuedJobs = this.targetRhizomeId
      ? this.queue.query({ status: "queued", rhizomeId: this.targetRhizomeId, readyOnly: true, atTime: this.now() })
      : this.queue.query({ status: "queued", readyOnly: true, atTime: this.now() });

    return (
      queuedJobs.find((job) => {
        const isAiStage = this.aiStages.has(job.stage);
        return ai ? isAiStage : !isAiStage;
      }) ?? null
    );
  }

  private async processJob(job: QueueJob, runId: string): Promise<boolean> {
    const startedAtDate = this.now();
    const startedAt = startedAtDate.toISOString();
    const handler = this.handlers[job.stage];

    this.queue.updateStatus({
      jobId: job.id,
      status: "processing",
      startedAt,
    });

    this.updateStudyStageStatus({
      rhizomeId: job.rhizomeId,
      stage: job.stage,
      status: PipelineStepStatus.PROCESSING,
      updatedAt: startedAt,
      retries: job.retryCount,
      error: null,
    });

    this.onEvent?.({
      type: "job-processing",
      rhizomeId: job.rhizomeId,
      stage: job.stage,
    });

    if (!handler) {
      const completedAt = this.now().toISOString();
      const message = `No handler registered for stage: ${job.stage}`;
      const nextRetryCount = job.retryCount + 1;

      this.queue.updateStatus({
        jobId: job.id,
        status: "paused",
        completedAt,
        errorMessage: message,
        errorClass: "permanent",
        incrementRetryCount: true,
        metadata: JSON.stringify(
          this.buildFailureMetadata({
            existingMetadata: job.metadata,
            classification: "permanent",
            retryCount: nextRetryCount,
            message,
            completedAt,
            pauseReason: "handler_missing",
          }),
        ),
      });

      this.updateStudyStageStatus({
        rhizomeId: job.rhizomeId,
        stage: job.stage,
        status: PipelineStepStatus.FAILED,
        updatedAt: completedAt,
        retries: nextRetryCount,
        error: message,
      });

      this.queue.recordPipelineRun({
        rhizomeId: job.rhizomeId,
        runId,
        step: job.stage,
        status: "failed",
        startedAt,
        completedAt,
        retries: nextRetryCount,
        skipReason: "handler_missing",
        error: message,
      });
      this.onEvent?.({
        type: "stage-handler-missing",
        rhizomeId: job.rhizomeId,
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
        rhizomeId: job.rhizomeId,
        stage: job.stage,
        status: PipelineStepStatus.COMPLETE,
        updatedAt: completedAt,
        retries: job.retryCount,
        durationMs,
        error: null,
      });

      const modelSkill = this.extractModelSkill(stageResult?.metadata);
      this.queue.recordPipelineRun({
        rhizomeId: job.rhizomeId,
        runId,
        step: job.stage,
        status: "completed",
        startedAt,
        completedAt,
        retries: job.retryCount,
        model: modelSkill.model,
        skill: modelSkill.skill,
      });

      this.onEvent?.({
        type: "job-complete",
        rhizomeId: job.rhizomeId,
        stage: job.stage,
      });

      return true;
    } catch (error) {
      const completedAtDate = this.now();
      const completedAt = completedAtDate.toISOString();
      const classification = this.classifyFailure(error);
      const message = this.errorMessage(error);
      const nextRetryCount = job.retryCount + 1;
      const canRetry = this.shouldRetry({
        classification,
        nextRetryCount,
        maxRetries: job.maxRetries,
      });

      const status = canRetry ? "queued" : "paused";
      const pauseReason = canRetry
        ? undefined
        : classification === "permanent"
          ? "permanent_error"
          : "max_retries_exhausted";

      this.queue.updateStatus({
        jobId: job.id,
        status,
        completedAt,
        errorMessage: message,
        errorClass: classification,
        incrementRetryCount: true,
        metadata: JSON.stringify(
          this.buildFailureMetadata({
            existingMetadata: job.metadata,
            classification,
            retryCount: nextRetryCount,
            message,
            completedAt,
            nextAttemptAt: canRetry ? this.nextAttemptAt(nextRetryCount, completedAtDate) : null,
            pauseReason,
          }),
        ),
      });

      this.updateStudyStageStatus({
        rhizomeId: job.rhizomeId,
        stage: job.stage,
        status: PipelineStepStatus.FAILED,
        updatedAt: completedAt,
        retries: nextRetryCount,
        error: message,
      });

      this.queue.recordPipelineRun({
        rhizomeId: job.rhizomeId,
        runId,
        step: job.stage,
        status: "failed",
        startedAt,
        completedAt,
        retries: nextRetryCount,
        error: message,
      });

      this.onEvent?.({
        type: "job-failed",
        rhizomeId: job.rhizomeId,
        stage: job.stage,
        detail: message,
      });

      return false;
    }
  }

  private classifyFailure(error: unknown): FailureClassification {
    if (!error || typeof error !== "object") {
      return "permanent";
    }

    const record = error as Record<string, unknown>;

    const classificationHint = this.readClassificationHint(record);
    if (classificationHint) {
      return classificationHint;
    }

    const retryable = this.readBooleanHint(record, ["retryable", "isRetryable", "transient"]);
    if (retryable !== null) {
      return retryable ? "transient" : "permanent";
    }

    const code = this.readStringHint(record, ["code", "errorCode", "name"]);
    if (code && this.isTransientCode(code)) {
      return "transient";
    }

    const message = this.errorMessage(error).toLowerCase();
    if (message.length > 0 && this.isTransientMessage(message)) {
      return "transient";
    }

    return "permanent";
  }

  private readClassificationHint(record: Record<string, unknown>): FailureClassification | null {
    const hint = this.readStringHint(record, [
      "errorClass",
      "error_class",
      "classification",
      "errorClassification",
      "kind",
      "type",
    ]);

    if (!hint) {
      return null;
    }

    const normalized = hint.trim().toLowerCase();
    if (normalized === "transient") {
      return "transient";
    }

    if (normalized === "permanent") {
      return "permanent";
    }

    return "permanent";
  }

  private readBooleanHint(record: Record<string, unknown>, keys: string[]): boolean | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "boolean") {
        return value;
      }
    }

    return null;
  }

  private readStringHint(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }

    return null;
  }

  private isTransientCode(code: string): boolean {
    const normalized = code.trim().toLowerCase();
    const transientCodes = new Set<string>([
      "timeout",
      "timeout_error",
      "request_timeout",
      "timed_out",
      "subprocess_timeout",
      "etimedout",
      "econnreset",
      "econnrefused",
      "enetunreach",
      "ehostunreach",
      "eai_again",
      "rate_limit",
      "rate_limited",
      "429",
      "500",
      "502",
      "503",
      "504",
      "temporary_unavailable",
      "service_unavailable",
    ]);

    if (transientCodes.has(normalized)) {
      return true;
    }

    return normalized.includes("timeout")
      || normalized.includes("rate")
      || normalized.includes("temporar")
      || normalized.includes("unavailable");
  }

  private isTransientMessage(message: string): boolean {
    return message.includes("timeout")
      || message.includes("timed out")
      || message.includes("temporarily unavailable")
      || message.includes("temporary failure")
      || message.includes("rate limit")
      || message.includes("too many requests")
      || message.includes("connection reset")
      || message.includes("connection refused")
      || message.includes("network")
      || message.includes("try again");
  }

  private shouldRetry(params: {
    classification: FailureClassification;
    nextRetryCount: number;
    maxRetries: number;
  }): boolean {
    if (params.classification !== "transient") {
      return false;
    }

    const maxRetries = Number.isFinite(params.maxRetries) ? Math.max(0, params.maxRetries) : 0;
    return params.nextRetryCount <= maxRetries;
  }

  private nextAttemptAt(retryCount: number, now: Date): string {
    const exponent = Math.max(0, retryCount - 1);
    const computedDelay = RETRY_BASE_DELAY_MS * Math.pow(2, exponent);
    const boundedDelay = Math.min(RETRY_MAX_DELAY_MS, computedDelay);

    return new Date(now.getTime() + boundedDelay).toISOString();
  }

  private errorMessage(error: unknown): string {
    let raw = "Stage execution failed";

    if (typeof error === "string" && error.trim().length > 0) {
      raw = error;
    } else if (error && typeof error === "object" && "message" in error) {
      const maybeMessage = (error as { message?: unknown }).message;
      if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
        raw = maybeMessage;
      }
    }

    return this.redactSensitiveText(raw.trim());
  }

  private redactSensitiveText(message: string): string {
    return message
      .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
      .replace(/\s+/g, " ");
  }

  private buildFailureMetadata(params: {
    existingMetadata: string | null;
    classification: FailureClassification;
    retryCount: number;
    message: string;
    completedAt: string;
    nextAttemptAt?: string | null;
    pauseReason?: string;
  }): Record<string, unknown> {
    const metadata = this.parseJobMetadata(params.existingMetadata);

    metadata.last_error = params.message;
    metadata.error_class = params.classification;
    metadata.retry_count = params.retryCount;
    metadata.last_failed_at = params.completedAt;

    if (params.nextAttemptAt) {
      metadata.next_attempt_at = params.nextAttemptAt;
    } else {
      delete metadata.next_attempt_at;
    }

    if (params.pauseReason) {
      metadata.pause_reason = params.pauseReason;
    } else {
      delete metadata.pause_reason;
    }

    return metadata;
  }

  private parseJobMetadata(metadata: string | null): Record<string, unknown> {
    if (!metadata) {
      return {};
    }

    try {
      const parsed = JSON.parse(metadata) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }

      return { ...(parsed as Record<string, unknown>) };
    } catch {
      return {};
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
      .query({ rhizomeId: job.rhizomeId, stage: nextStage })
      .find((candidate) => candidate.status === "queued" || candidate.status === "processing");

    if (existing) {
      return 0;
    }

    this.queue.enqueue({
      rhizomeId: job.rhizomeId,
      stage: nextStage,
      status: "queued",
      aiWindowRequired: this.aiStages.has(nextStage),
    });

    this.updateStudyStageStatus({
      rhizomeId: job.rhizomeId,
      stage: nextStage,
      status: PipelineStepStatus.QUEUED,
      updatedAt: this.now().toISOString(),
      retries: 0,
      error: null,
    });

    this.onEvent?.({
      type: "stage-enqueued",
      rhizomeId: job.rhizomeId,
      stage: nextStage,
    });

    return 1;
  }

  private buildRunId(): string {
    return crypto.randomUUID();
  }

  private extractModelSkill(
    metadata: Record<string, unknown> | undefined,
  ): { model: string | null; skill: string | null } {
    if (!metadata) {
      return { model: null, skill: null };
    }

    const model = this.firstString(metadata, ["model", "summary_model", "classifier_model"]);
    const skill = this.firstString(metadata, [
      "skill",
      "summary_skill",
      "classifier_skill",
      "summary_skill_version",
      "classifier_skill_version",
    ]);

    return { model, skill };
  }

  private firstString(
    record: Record<string, unknown>,
    keys: string[],
  ): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }

    return null;
  }

  private updateStudyStageStatus(params: {
    rhizomeId: string;
    stage: PipelineStep;
    status: PipelineStepStatus;
    updatedAt: string;
    retries: number;
    error: string | null;
    durationMs?: number;
  }): void {
    const state = this.readStudyState(params.rhizomeId);

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
        WHERE rhizome_id = ?;
        `,
      )
      .run(
        JSON.stringify(pipelineSteps),
        overall,
        params.error,
        params.updatedAt,
        params.rhizomeId,
      );
  }

  private readStudyState(rhizomeId: string): StudyStateRow {
    const row = this.db
      .query(
        `
        SELECT pipeline_steps_json, pipeline_overall, pipeline_error
        FROM studies
        WHERE rhizome_id = ?
        LIMIT 1;
        `,
      )
      .get(rhizomeId) as StudyStateRow | null;

    if (!row) {
      throw new Error(`Study not found for rhizome_id=${rhizomeId}`);
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
