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

function insertStudy(database: Database, rhizomeId: string, citekey: string): void {
  database.db
    .query(
      `
      INSERT INTO studies (rhizome_id, citekey, source, title, pipeline_overall, pipeline_steps_json)
      VALUES (?, ?, ?, ?, ?, ?);
      `,
    )
    .run(rhizomeId, citekey, "manual", `Study ${rhizomeId}`, PipelineOverallStatus.NOT_STARTED, "{}");
}

function readPipelineState(database: Database, rhizomeId: string): {
  overall: PipelineOverallStatus;
  steps: Record<string, { status: PipelineStepStatus; updated_at: string; retries: number }>;
  error: string | null;
} {
  const row = database.db
    .query(
      `
      SELECT pipeline_overall, pipeline_steps_json, pipeline_error
      FROM studies
      WHERE rhizome_id = ?
      LIMIT 1;
      `,
    )
    .get(rhizomeId) as {
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

function readPipelineRuns(database: Database, rhizomeId: string): Array<{
  run_id: string;
  step: PipelineStep;
  status: string;
  retries: number;
  error: string | null;
}> {
  return database.db
    .query(
      `
      SELECT run_id, step, status, retries, error
      FROM pipeline_runs
      WHERE rhizome_id = ?
      ORDER BY id ASC;
      `,
    )
    .all(rhizomeId) as Array<{
    run_id: string;
    step: PipelineStep;
    status: string;
    retries: number;
    error: string | null;
  }>;
}

describe("PipelineOrchestrator", () => {
  test("processNonAI and processAI move phase-1 stages forward sequentially", async () => {
    await withDatabase(async (database) => {
      insertStudy(database, "SISS-001", "smith2026study");

      const queue = new JobQueue(database.db);
      queue.enqueue({
        rhizomeId: "SISS-001",
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
      orchestrator.registerStageHandler(PipelineStep.SUMMARIZE, async ({ job }) => {
        callOrder.push(job.stage);
      });
      orchestrator.registerStageHandler(PipelineStep.VAULT_WRITE, async ({ job }) => {
        callOrder.push(job.stage);
      });

      const nonAiResult = await orchestrator.processNonAI();
      expect(nonAiResult).toEqual({
        processed: 2,
        succeeded: 2,
        failed: 0,
        enqueued: 2,
      });

      const stateAfterNonAI = readPipelineState(database, "SISS-001");
      expect(stateAfterNonAI.overall).toBe(PipelineOverallStatus.IN_PROGRESS);
      expect(stateAfterNonAI.steps[PipelineStep.INGEST]?.status).toBe(PipelineStepStatus.COMPLETE);
      expect(stateAfterNonAI.steps[PipelineStep.ZOTERO_SYNC]?.status).toBe(PipelineStepStatus.COMPLETE);
      expect(stateAfterNonAI.steps[PipelineStep.SUMMARIZE]?.status).toBe(PipelineStepStatus.QUEUED);

      const queuedAfterNonAI = queue.query({ rhizomeId: "SISS-001", status: "queued" });
      expect(queuedAfterNonAI.map((job) => job.stage)).toEqual([PipelineStep.SUMMARIZE]);

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

      const pipelineRuns = readPipelineRuns(database, "SISS-001");
      expect(pipelineRuns).toHaveLength(4);
      expect(pipelineRuns.map((row) => row.step)).toEqual([
        PipelineStep.INGEST,
        PipelineStep.ZOTERO_SYNC,
        PipelineStep.SUMMARIZE,
        PipelineStep.VAULT_WRITE,
      ]);
      expect(pipelineRuns.every((row) => row.status === "completed")).toBe(true);
      expect(pipelineRuns.every((row) => row.retries === 0)).toBe(true);
      expect(new Set(pipelineRuns.map((row) => row.run_id)).size).toBe(3);

      expect(callOrder).toEqual([
        PipelineStep.INGEST,
        PipelineStep.ZOTERO_SYNC,
        PipelineStep.SUMMARIZE,
        PipelineStep.VAULT_WRITE,
      ]);
    });
  });

  test("records failed pipeline_runs entries when a stage handler throws", async () => {
    await withDatabase(async (database) => {
      insertStudy(database, "SISS-FAIL-001", "smith2026fail");

      const queue = new JobQueue(database.db);
      queue.enqueue({
        rhizomeId: "SISS-FAIL-001",
        stage: PipelineStep.INGEST,
        status: "queued",
      });

      const orchestrator = new PipelineOrchestrator({
        db: database.db,
        queue,
      });

      orchestrator.registerStageHandler(PipelineStep.INGEST, async () => {
        throw new Error("ingest exploded");
      });

      const result = await orchestrator.processNonAI();
      expect(result).toEqual({
        processed: 1,
        succeeded: 0,
        failed: 1,
        enqueued: 0,
      });

      const pipelineRuns = readPipelineRuns(database, "SISS-FAIL-001");
      expect(pipelineRuns).toHaveLength(1);
      expect(pipelineRuns[0]?.status).toBe("failed");
      expect(pipelineRuns[0]?.step).toBe(PipelineStep.INGEST);
      expect(pipelineRuns[0]?.retries).toBe(1);
      expect(pipelineRuns[0]?.error).toContain("ingest exploded");
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
        [PipelineStep.VAULT_WRITE]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-25T00:03:00.000Z",
          retries: 0,
        },
      }),
    ).toBe(PipelineOverallStatus.COMPLETE);
  });
});
