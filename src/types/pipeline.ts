export enum PipelineOverallStatus {
  NOT_STARTED = "not_started",
  IN_PROGRESS = "in_progress",
  COMPLETE = "complete",
  NEEDS_ATTENTION = "needs_attention",
}

export enum PipelineStep {
  INGEST = "ingest",
  ZOTERO_SYNC = "zotero_sync",
  PDF_FETCH = "pdf_fetch",
  FULLTEXT_MARKER = "fulltext.marker",
  FULLTEXT_DOCLING = "fulltext.docling",
  SUMMARIZE = "summarize",
  CLASSIFY = "classify",
  VAULT_WRITE = "vault_write",
  BASES_SYNC = "bases_sync",
}

export enum PipelineStepStatus {
  PENDING = "pending",
  QUEUED = "queued",
  PROCESSING = "processing",
  COMPLETE = "complete",
  SKIPPED = "skipped",
  FAILED = "failed",
  BLOCKED = "blocked",
}

// Queue/job status values from specs/02-pipeline-queue.md `jobs` table definition.
export type JobStatus =
  | "queued"
  | "processing"
  | "complete"
  | "error"
  | "paused"
  | "skipped";

export interface PipelineStepState {
  status: PipelineStepStatus;
  updated_at: string;
  retries: number;
  error?: string;
  skip_reason?: string;
  duration_ms?: number;
}
