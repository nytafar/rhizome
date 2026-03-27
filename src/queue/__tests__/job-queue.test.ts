import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../db/database";
import { JobQueue } from "../job-queue";
import { PipelineStep } from "../../types/pipeline";

async function withDatabase<T>(run: (database: Database) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "rhizome-queue-"));
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
      INSERT INTO studies (rhizome_id, citekey, source, title)
      VALUES (?, ?, ?, ?);
      `,
    )
    .run(rhizomeId, citekey, "manual", `Study ${rhizomeId}`);
}

describe("JobQueue", () => {
  test("enqueue and dequeue respects priority then created order", async () => {
    await withDatabase((database) => {
      insertStudy(database, "SISS-001", "alpha2024study");
      insertStudy(database, "SISS-002", "bravo2024study");
      insertStudy(database, "SISS-003", "charlie2024study");

      const queue = new JobQueue(database.db);
      queue.enqueue({ rhizomeId: "SISS-001", stage: PipelineStep.INGEST, priority: 0 });
      queue.enqueue({ rhizomeId: "SISS-002", stage: PipelineStep.INGEST, priority: 10 });
      queue.enqueue({ rhizomeId: "SISS-003", stage: PipelineStep.INGEST, priority: 10 });

      const first = queue.dequeue();
      expect(first?.rhizomeId).toBe("SISS-002");
      queue.updateStatus({ jobId: first!.id, status: "processing" });

      const second = queue.dequeue();
      expect(second?.rhizomeId).toBe("SISS-003");
      queue.updateStatus({ jobId: second!.id, status: "processing" });

      const third = queue.dequeue();
      expect(third?.rhizomeId).toBe("SISS-001");
    });
  });

  test("updateStatus applies transitions and retry increments", async () => {
    await withDatabase((database) => {
      insertStudy(database, "SISS-010", "delta2024study");
      const queue = new JobQueue(database.db);

      const jobId = queue.enqueue({
        rhizomeId: "SISS-010",
        stage: PipelineStep.SUMMARIZE,
        priority: 5,
        aiWindowRequired: true,
      });

      queue.updateStatus({
        jobId,
        status: "processing",
        startedAt: "2026-03-25T19:00:00Z",
      });

      queue.updateStatus({
        jobId,
        status: "error",
        errorMessage: "rate limit",
        errorClass: "transient",
        incrementRetryCount: true,
      });

      queue.updateStatus({
        jobId,
        status: "complete",
        errorMessage: null,
        errorClass: null,
        completedAt: "2026-03-25T19:01:00Z",
      });

      const [updated] = queue.query({ rhizomeId: "SISS-010", stage: PipelineStep.SUMMARIZE });

      expect(updated).toBeDefined();
      if (!updated) {
        throw new Error("Expected updated job to exist");
      }

      expect(updated.status).toBe("complete");
      expect(updated.retryCount).toBe(1);
      expect(updated.errorMessage).toBeNull();
      expect(updated.errorClass).toBeNull();
      expect(updated.startedAt).toBe("2026-03-25T19:00:00Z");
      expect(updated.completedAt).toBe("2026-03-25T19:01:00Z");
      expect(updated.aiWindowRequired).toBe(true);
    });
  });

  test("query filters by rhizome_id, stage, and status", async () => {
    await withDatabase((database) => {
      insertStudy(database, "SISS-100", "echo2024study");
      insertStudy(database, "SISS-101", "foxtrot2024study");

      const queue = new JobQueue(database.db);
      queue.enqueue({ rhizomeId: "SISS-100", stage: PipelineStep.PDF_FETCH, status: "queued", priority: 0 });
      queue.enqueue({ rhizomeId: "SISS-100", stage: PipelineStep.SUMMARIZE, status: "processing", priority: 0 });
      queue.enqueue({ rhizomeId: "SISS-101", stage: PipelineStep.SUMMARIZE, status: "queued", priority: 0 });

      const byStudy = queue.query({ rhizomeId: "SISS-100" });
      expect(byStudy).toHaveLength(2);

      const byStageAndStatus = queue.query({
        stage: PipelineStep.SUMMARIZE,
        status: "queued",
      });
      expect(byStageAndStatus).toHaveLength(1);
      expect(byStageAndStatus[0]?.rhizomeId).toBe("SISS-101");
    });
  });

  test("dequeue skips queued jobs until next_attempt_at is eligible", async () => {
    await withDatabase((database) => {
      insertStudy(database, "SISS-150", "future2024study");
      insertStudy(database, "SISS-151", "ready2024study");

      const queue = new JobQueue(database.db);
      queue.enqueue({
        rhizomeId: "SISS-150",
        stage: PipelineStep.INGEST,
        status: "queued",
        priority: 10,
        metadata: '{"next_attempt_at":"2099-01-01T00:00:00.000Z"}',
      });
      queue.enqueue({
        rhizomeId: "SISS-151",
        stage: PipelineStep.INGEST,
        status: "queued",
        priority: 1,
      });

      const next = queue.dequeue();
      expect(next?.rhizomeId).toBe("SISS-151");
    });
  });

  test("query readyOnly includes malformed metadata rows as ready", async () => {
    await withDatabase((database) => {
      insertStudy(database, "SISS-160", "malformed2024study");
      insertStudy(database, "SISS-161", "future2024study");

      const queue = new JobQueue(database.db);
      queue.enqueue({
        rhizomeId: "SISS-160",
        stage: PipelineStep.SUMMARIZE,
        status: "queued",
        metadata: "not-json",
      });
      queue.enqueue({
        rhizomeId: "SISS-161",
        stage: PipelineStep.SUMMARIZE,
        status: "queued",
        metadata: '{"next_attempt_at":"2099-01-01T00:00:00.000Z"}',
      });

      const readyJobs = queue.query({
        stage: PipelineStep.SUMMARIZE,
        status: "queued",
        readyOnly: true,
        atTime: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(readyJobs).toHaveLength(1);
      expect(readyJobs[0]?.rhizomeId).toBe("SISS-160");
    });
  });

  test("recordStageLog writes execution entries", async () => {
    await withDatabase((database) => {
      insertStudy(database, "SISS-200", "golf2024study");
      const queue = new JobQueue(database.db);

      const logId = queue.recordStageLog({
        rhizomeId: "SISS-200",
        stage: PipelineStep.CLASSIFY,
        status: "completed",
        startedAt: "2026-03-25T20:00:00Z",
        completedAt: "2026-03-25T20:00:15Z",
        durationMs: 15000,
        metadata: '{"model":"claude-3"}',
      });

      expect(logId).toBeGreaterThan(0);

      const row = database.db
        .query(
          `
          SELECT rhizome_id, stage, status, duration_ms, metadata
          FROM job_stage_log
          WHERE id = ?;
          `,
        )
        .get(logId) as {
        rhizome_id: string;
        stage: string;
        status: string;
        duration_ms: number;
        metadata: string;
      };

      expect(row).toEqual({
        rhizome_id: "SISS-200",
        stage: PipelineStep.CLASSIFY,
        status: "completed",
        duration_ms: 15000,
        metadata: '{"model":"claude-3"}',
      });
    });
  });
});
