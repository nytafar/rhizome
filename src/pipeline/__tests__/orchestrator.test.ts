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
      orchestrator.registerStageHandler(PipelineStep.PDF_FETCH, async ({ job }) => {
        callOrder.push(job.stage);
      });
      orchestrator.registerStageHandler(PipelineStep.FULLTEXT_MARKER, async ({ job }) => {
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
        processed: 4,
        succeeded: 4,
        failed: 0,
        enqueued: 4,
      });

      const stateAfterNonAI = readPipelineState(database, "SISS-001");
      expect(stateAfterNonAI.overall).toBe(PipelineOverallStatus.IN_PROGRESS);
      expect(stateAfterNonAI.steps[PipelineStep.INGEST]?.status).toBe(PipelineStepStatus.COMPLETE);
      expect(stateAfterNonAI.steps[PipelineStep.ZOTERO_SYNC]?.status).toBe(PipelineStepStatus.COMPLETE);
      expect(stateAfterNonAI.steps[PipelineStep.PDF_FETCH]?.status).toBe(PipelineStepStatus.COMPLETE);
      expect(stateAfterNonAI.steps[PipelineStep.FULLTEXT_MARKER]?.status).toBe(PipelineStepStatus.COMPLETE);
      expect(stateAfterNonAI.steps[PipelineStep.SUMMARIZE]?.status).toBe(PipelineStepStatus.QUEUED);

      const queuedAfterNonAI = queue.query({ rhizomeId: "SISS-001", status: "queued" });
      expect(queuedAfterNonAI.map((job) => job.stage)).toEqual([PipelineStep.SUMMARIZE]);

      const nonAiRetry = await orchestrator.processNonAI();
      expect(nonAiRetry).toEqual({
        processed: 0,
        succeeded: 0,
        failed: 0,
        enqueued: 0,
      });

      const aiResult = await orchestrator.processAI({
        windows: ["00:00-23:59"],
        timezone: "UTC",
      });
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
        PipelineStep.FULLTEXT_MARKER,
        PipelineStep.SUMMARIZE,
        PipelineStep.VAULT_WRITE,
      ]);
    });
  });

  test("default stage sequence includes fulltext.marker before summarize", async () => {
    await withDatabase(async (database) => {
      insertStudy(database, "SISS-004", "lane2026defaultflow");

      const queue = new JobQueue(database.db);
      queue.enqueue({
        rhizomeId: "SISS-004",
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
      orchestrator.registerStageHandler(PipelineStep.FULLTEXT_MARKER, async ({ job }) => {
        callOrder.push(job.stage);
      });

      const nonAiResult = await orchestrator.processNonAI();
      expect(nonAiResult).toEqual({
        processed: 4,
        succeeded: 4,
        failed: 0,
        enqueued: 4,
      });

      expect(callOrder).toEqual([
        PipelineStep.INGEST,
        PipelineStep.ZOTERO_SYNC,
        PipelineStep.PDF_FETCH,
        PipelineStep.FULLTEXT_MARKER,
      ]);

      const queued = queue.query({ rhizomeId: "SISS-004", status: "queued" }).map((job) => job.stage);
      expect(queued).toEqual([PipelineStep.SUMMARIZE]);

      const fulltextQueued = queue.query({
        rhizomeId: "SISS-004",
        stage: PipelineStep.FULLTEXT_MARKER,
        status: "queued",
      });
      expect(fulltextQueued).toHaveLength(0);
    });
  });

  test("processAI keeps AI jobs queued when window is inactive", async () => {
    await withDatabase(async (database) => {
      insertStudy(database, "SISS-005", "night2026hold");

      const queue = new JobQueue(database.db);
      const summarizeJobId = queue.enqueue({
        rhizomeId: "SISS-005",
        stage: PipelineStep.SUMMARIZE,
        status: "queued",
        aiWindowRequired: true,
      });

      const orchestrator = new PipelineOrchestrator({
        db: database.db,
        queue,
        now: () => new Date("2026-03-27T10:00:00.000Z"),
      });

      orchestrator.registerStageHandler(PipelineStep.SUMMARIZE, async () => {
        throw new Error("handler should not run outside AI window");
      });

      const result = await orchestrator.processAI({
        windows: ["11:00-12:00"],
        timezone: "UTC",
      });

      expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0, enqueued: 0 });

      const job = queue.query({ stage: PipelineStep.SUMMARIZE }).find((entry) => entry.id === summarizeJobId);
      expect(job?.status).toBe("queued");
    });
  });

  test("processAI applies cooldown between successful AI jobs", async () => {
    await withDatabase(async (database) => {
      insertStudy(database, "SISS-006", "cooldown2026");
      insertStudy(database, "SISS-007", "cooldown2027");

      const queue = new JobQueue(database.db);
      queue.enqueue({
        rhizomeId: "SISS-006",
        stage: PipelineStep.SUMMARIZE,
        status: "queued",
        aiWindowRequired: true,
      });
      queue.enqueue({
        rhizomeId: "SISS-007",
        stage: PipelineStep.SUMMARIZE,
        status: "queued",
        aiWindowRequired: true,
      });

      const sleepCalls: number[] = [];
      const orchestrator = new PipelineOrchestrator({
        db: database.db,
        queue,
      });

      orchestrator.registerStageHandler(PipelineStep.SUMMARIZE, async () => {
        // no-op
      });

      const result = await orchestrator.processAI({
        windows: ["00:00-23:59"],
        timezone: "UTC",
        cooldownSeconds: 2,
        sleep: async (milliseconds) => {
          sleepCalls.push(milliseconds);
        },
      });

      expect(result).toEqual({ processed: 2, succeeded: 2, failed: 0, enqueued: 2 });
      expect(sleepCalls).toEqual([2000]);
    });
  });

  test("processAI stops mid-batch when window expires", async () => {
    await withDatabase(async (database) => {
      insertStudy(database, "SISS-008", "boundary2026a");
      insertStudy(database, "SISS-009", "boundary2026b");

      const queue = new JobQueue(database.db);
      queue.enqueue({
        rhizomeId: "SISS-008",
        stage: PipelineStep.SUMMARIZE,
        status: "queued",
        aiWindowRequired: true,
      });
      queue.enqueue({
        rhizomeId: "SISS-009",
        stage: PipelineStep.SUMMARIZE,
        status: "queued",
        aiWindowRequired: true,
      });

      let nowCall = 0;
      const nowValues = [
        new Date("2026-03-27T10:30:00.000Z"),
        new Date("2026-03-27T10:30:01.000Z"),
        new Date("2026-03-27T10:30:02.000Z"),
        new Date("2026-03-27T10:30:03.000Z"),
        new Date("2026-03-27T11:30:00.000Z"),
      ];
      const orchestrator = new PipelineOrchestrator({
        db: database.db,
        queue,
        now: () => {
          const value = nowValues[Math.min(nowCall, nowValues.length - 1)];
          nowCall += 1;
          return value;
        },
      });

      orchestrator.registerStageHandler(PipelineStep.SUMMARIZE, async () => {
        // no-op
      });

      const result = await orchestrator.processAI({
        windows: ["10:00-11:00"],
        timezone: "UTC",
      });

      expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, enqueued: 1 });
      const queued = queue.query({ stage: PipelineStep.SUMMARIZE, status: "queued" });
      expect(queued).toHaveLength(1);
      expect(queued[0]?.rhizomeId).toBe("SISS-009");
    });
  });

  test("processAI rejects malformed window config and preserves queued jobs", async () => {
    await withDatabase(async (database) => {
      insertStudy(database, "SISS-010", "malformed2026");

      const queue = new JobQueue(database.db);
      const jobId = queue.enqueue({
        rhizomeId: "SISS-010",
        stage: PipelineStep.SUMMARIZE,
        status: "queued",
        aiWindowRequired: true,
      });

      const orchestrator = new PipelineOrchestrator({
        db: database.db,
        queue,
      });

      await expect(
        orchestrator.processAI({
          windows: [],
          timezone: "UTC",
        }),
      ).rejects.toThrow("Invalid AI window configuration");

      const job = queue.query({ stage: PipelineStep.SUMMARIZE }).find((entry) => entry.id === jobId);
      expect(job?.status).toBe("queued");
    });
  });

  test("processAI surfaces queue errors when window is active", async () => {
    await withDatabase(async (database) => {
      const queue = new JobQueue(database.db);
      const orchestrator = new PipelineOrchestrator({
        db: database.db,
        queue,
      });

      const querySpy = () => {
        throw new Error("queue query failure");
      };

      const originalQuery = queue.query.bind(queue);
      queue.query = querySpy as unknown as typeof queue.query;

      await expect(
        orchestrator.processAI({
          windows: ["00:00-23:59"],
          timezone: "UTC",
        }),
      ).rejects.toThrow("queue query failure");

      queue.query = originalQuery;
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
        [PipelineStep.FULLTEXT_MARKER]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-25T00:02:45.000Z",
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
