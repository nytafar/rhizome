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

function insertStudy(database: Database, sissId: string, citekey: string): void {
  database.db
    .query(
      `
      INSERT INTO studies (siss_id, citekey, source, title)
      VALUES (?, ?, ?, ?);
      `,
    )
    .run(sissId, citekey, "manual", `Study ${sissId}`);
}

describe("JobQueue", () => {
  test("enqueue and dequeue respects priority then created order", async () => {
    await withDatabase((database) => {
      insertStudy(database, "SISS-001", "alpha2024study");
      insertStudy(database, "SISS-002", "bravo2024study");
      insertStudy(database, "SISS-003", "charlie2024study");

      const queue = new JobQueue(database.db);
      queue.enqueue({ sissId: "SISS-001", stage: PipelineStep.INGEST, priority: 0 });
      queue.enqueue({ sissId: "SISS-002", stage: PipelineStep.INGEST, priority: 10 });
      queue.enqueue({ sissId: "SISS-003", stage: PipelineStep.INGEST, priority: 10 });

      const first = queue.dequeue();
      expect(first?.sissId).toBe("SISS-002");
      queue.updateStatus({ jobId: first!.id, status: "processing" });

      const second = queue.dequeue();
      expect(second?.sissId).toBe("SISS-003");
      queue.updateStatus({ jobId: second!.id, status: "processing" });

      const third = queue.dequeue();
      expect(third?.sissId).toBe("SISS-001");
    });
  });

  test("updateStatus applies transitions and retry increments", async () => {
    await withDatabase((database) => {
      insertStudy(database, "SISS-010", "delta2024study");
      const queue = new JobQueue(database.db);

      const jobId = queue.enqueue({
        sissId: "SISS-010",
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

      const [updated] = queue.query({ sissId: "SISS-010", stage: PipelineStep.SUMMARIZE });

      expect(updated).toBeDefined();
      expect(updated.status).toBe("complete");
      expect(updated.retryCount).toBe(1);
      expect(updated.errorMessage).toBeNull();
      expect(updated.errorClass).toBeNull();
      expect(updated.startedAt).toBe("2026-03-25T19:00:00Z");
      expect(updated.completedAt).toBe("2026-03-25T19:01:00Z");
      expect(updated.aiWindowRequired).toBe(true);
    });
  });

  test("query filters by siss_id, stage, and status", async () => {
    await withDatabase((database) => {
      insertStudy(database, "SISS-100", "echo2024study");
      insertStudy(database, "SISS-101", "foxtrot2024study");

      const queue = new JobQueue(database.db);
      queue.enqueue({ sissId: "SISS-100", stage: PipelineStep.PDF_FETCH, status: "queued", priority: 0 });
      queue.enqueue({ sissId: "SISS-100", stage: PipelineStep.SUMMARIZE, status: "processing", priority: 0 });
      queue.enqueue({ sissId: "SISS-101", stage: PipelineStep.SUMMARIZE, status: "queued", priority: 0 });

      const byStudy = queue.query({ sissId: "SISS-100" });
      expect(byStudy).toHaveLength(2);

      const byStageAndStatus = queue.query({
        stage: PipelineStep.SUMMARIZE,
        status: "queued",
      });
      expect(byStageAndStatus).toHaveLength(1);
      expect(byStageAndStatus[0]?.sissId).toBe("SISS-101");
    });
  });

  test("recordStageLog writes execution entries", async () => {
    await withDatabase((database) => {
      insertStudy(database, "SISS-200", "golf2024study");
      const queue = new JobQueue(database.db);

      const logId = queue.recordStageLog({
        sissId: "SISS-200",
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
          SELECT siss_id, stage, status, duration_ms, metadata
          FROM job_stage_log
          WHERE id = ?;
          `,
        )
        .get(logId) as {
        siss_id: string;
        stage: string;
        status: string;
        duration_ms: number;
        metadata: string;
      };

      expect(row).toEqual({
        siss_id: "SISS-200",
        stage: PipelineStep.CLASSIFY,
        status: "completed",
        duration_ms: 15000,
        metadata: '{"model":"claude-3"}',
      });
    });
  });
});
