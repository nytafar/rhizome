import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../db/database";
import { JobQueue } from "../../queue/job-queue";
import {
  PipelineOverallStatus,
  PipelineStep,
  PipelineStepStatus,
} from "../../types/pipeline";
import { PipelineOrchestrator, derivePipelineOverall } from "../orchestrator";

async function withDatabase<T>(run: (database: Database) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "rhizome-orchestrator-"));
  const dbPath = join(dir, "rhizome.sqlite");

  try {
    const database = new Database({ path: dbPath });
    database.init();
    return await run(database);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function insertStudy(database: Database, sissId: string, citekey: string): void {
  database.db
    .query(
      `
      INSERT INTO studies (siss_id, citekey, source, title, pipeline_overall, pipeline_steps_json)
      VALUES (?, ?, ?, ?, ?, ?);
      `,
    )
    .run(sissId, citekey, "manual", `Study ${sissId}`, PipelineOverallStatus.NOT_STARTED, "{}");
}

function readPipelineState(database: Database, sissId: string): {
  overall: PipelineOverallStatus;
  steps: Record<string, { status: PipelineStepStatus; updated_at: string; retries: number }>;
  error: string | null;
} {
  const row = database.db
    .query(
      `
      SELECT pipeline_overall, pipeline_steps_json, pipeline_error
      FROM studies
      WHERE siss_id = ?
      LIMIT 1;
      `,
    )
    .get(sissId) as {
    pipeline_overall: PipelineOverallStatus;
    pipeline_steps_json: string;
    pipeline_error: string | null;
  };

  return {
    overall: row.pipeline_overall,
    steps: JSON.parse(row.pipeline_steps_json) as Record<
      string,
      { status: PipelineStepStatus; updated_at: string; retries: number }
    >,
    error: row.pipeline_error,
  };
}

describe("PipelineOrchestrator", () => {
  test("processNonAI and processAI move phase-1 stages forward sequentially", async () => {
    await withDatabase(async (database) => {
      insertStudy(database, "SISS-001", "smith2026study");

      const queue = new JobQueue(database.db);
      queue.enqueue({
        sissId: "SISS-001",
        stage: PipelineStep.INGEST,
        status: "queued",
      });

      const callOrder: PipelineStep[] = [];
      const orchestrator = new PipelineOrchestrator({
        db: database.db,
        queue,
      });

      orchestrator.registerStageHandler(PipelineStep.INGEST, async ({ job }) => {
        callOrder.push(job.stage);
      });
      orchestrator.registerStageHandler(PipelineStep.ZOTERO_SYNC, async ({ job }) => {
        callOrder.push(job.stage);
      });
      orchestrator.registerStageHandler(PipelineStep.PDF_FETCH, async ({ job }) => {
        callOrder.push(job.stage);
      });
      orchestrator.registerStageHandler(PipelineStep.SUMMARIZE, async ({ job }) => {
        callOrder.push(job.stage);
      });
      orchestrator.registerStageHandler(PipelineStep.VAULT_WRITE, async ({ job }) => {
        callOrder.push(job.stage);
      });

      const nonAiResult = await orchestrator.processNonAI();
      expect(nonAiResult).toEqual({
        processed: 3,
        succeeded: 3,
        failed: 0,
        enqueued: 3,
      });

      const stateAfterNonAI = readPipelineState(database, "SISS-001");
      expect(stateAfterNonAI.overall).toBe(PipelineOverallStatus.IN_PROGRESS);
      expect(stateAfterNonAI.steps[PipelineStep.INGEST]?.status).toBe(PipelineStepStatus.COMPLETE);
      expect(stateAfterNonAI.steps[PipelineStep.ZOTERO_SYNC]?.status).toBe(PipelineStepStatus.COMPLETE);
      expect(stateAfterNonAI.steps[PipelineStep.PDF_FETCH]?.status).toBe(PipelineStepStatus.COMPLETE);
      expect(stateAfterNonAI.steps[PipelineStep.SUMMARIZE]?.status).toBe(PipelineStepStatus.QUEUED);

      const queuedAfterNonAI = queue.query({ sissId: "SISS-001", status: "queued" });
      expect(queuedAfterNonAI.map((job) => job.stage)).toEqual([PipelineStep.SUMMARIZE]);

      const nonAiRetry = await orchestrator.processNonAI();
      expect(nonAiRetry).toEqual({
        processed: 0,
        succeeded: 0,
        failed: 0,
        enqueued: 0,
      });

      const aiResult = await orchestrator.processAI();
      expect(aiResult).toEqual({
        processed: 1,
        succeeded: 1,
        failed: 0,
        enqueued: 1,
      });

      const secondNonAiResult = await orchestrator.processNonAI();
      expect(secondNonAiResult).toEqual({
        processed: 1,
        succeeded: 1,
        failed: 0,
        enqueued: 0,
      });

      const finalState = readPipelineState(database, "SISS-001");
      expect(finalState.overall).toBe(PipelineOverallStatus.COMPLETE);
      expect(finalState.error).toBeNull();
      expect(finalState.steps[PipelineStep.SUMMARIZE]?.status).toBe(PipelineStepStatus.COMPLETE);
      expect(finalState.steps[PipelineStep.VAULT_WRITE]?.status).toBe(PipelineStepStatus.COMPLETE);

      expect(callOrder).toEqual([
        PipelineStep.INGEST,
        PipelineStep.ZOTERO_SYNC,
        PipelineStep.PDF_FETCH,
        PipelineStep.SUMMARIZE,
        PipelineStep.VAULT_WRITE,
      ]);
    });
  });

  test("derivePipelineOverall returns expected aggregate state", () => {
    expect(derivePipelineOverall({})).toBe(PipelineOverallStatus.NOT_STARTED);

    expect(
      derivePipelineOverall({
        [PipelineStep.INGEST]: {
          status: PipelineStepStatus.QUEUED,
          updated_at: "2026-03-25T00:00:00.000Z",
          retries: 0,
        },
      }),
    ).toBe(PipelineOverallStatus.IN_PROGRESS);

    expect(
      derivePipelineOverall({
        [PipelineStep.INGEST]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-25T00:00:00.000Z",
          retries: 0,
        },
        [PipelineStep.ZOTERO_SYNC]: {
          status: PipelineStepStatus.FAILED,
          updated_at: "2026-03-25T00:01:00.000Z",
          retries: 1,
          error: "sync failed",
        },
      }),
    ).toBe(PipelineOverallStatus.NEEDS_ATTENTION);

    expect(
      derivePipelineOverall({
        [PipelineStep.INGEST]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-25T00:00:00.000Z",
          retries: 0,
        },
        [PipelineStep.ZOTERO_SYNC]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-25T00:01:00.000Z",
          retries: 0,
        },
        [PipelineStep.SUMMARIZE]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-25T00:02:00.000Z",
          retries: 0,
        },
        [PipelineStep.PDF_FETCH]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-25T00:02:30.000Z",
          retries: 0,
        },
        [PipelineStep.VAULT_WRITE]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-25T00:03:00.000Z",
          retries: 0,
        },
      }),
    ).toBe(PipelineOverallStatus.COMPLETE);
  });
});
