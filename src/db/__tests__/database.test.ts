import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../database";

describe("Database", () => {
  test("initializes schema, enables WAL, and records schema version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rhizome-db-"));
    const dbPath = join(dir, "rhizome.sqlite");

    try {
      const database = new Database({ path: dbPath });
      database.init();

      const journalMode = database.db.query("PRAGMA journal_mode;").get() as {
        journal_mode: string;
      };

      expect(journalMode.journal_mode.toLowerCase()).toBe("wal");

      const tables = database.db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
        )
        .all() as Array<{ name: string }>;

      expect(tables.map((table) => table.name)).toEqual([
        "config_meta",
        "job_stage_log",
        "jobs",
        "studies",
        "zotero_sync_state",
      ]);

      const schemaVersion = database.db
        .query("SELECT value FROM config_meta WHERE key = 'db_schema_version';")
        .get() as { value: string };

      expect(schemaVersion.value).toBe("1");

      database.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("supports basic CRUD and stage logging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rhizome-db-crud-"));
    const dbPath = join(dir, "rhizome.sqlite");

    try {
      const database = new Database({ path: dbPath });
      database.init();

      database.db
        .query(
          `
          INSERT INTO studies (siss_id, citekey, source, title)
          VALUES (?, ?, ?, ?);
        `,
        )
        .run("SISS-001", "smith2023ashwagandha", "manual", "Ashwagandha Trial");

      database.db
        .query(
          `
          INSERT INTO jobs (siss_id, stage, status, priority, ai_window_required)
          VALUES (?, ?, ?, ?, ?);
        `,
        )
        .run("SISS-001", "summarize", "queued", 10, true);

      database.db
        .query(
          `
          INSERT INTO job_stage_log (siss_id, stage, status, started_at, completed_at, duration_ms, metadata)
          VALUES (?, ?, ?, datetime('now'), datetime('now'), ?, ?);
        `,
        )
        .run("SISS-001", "summarize", "completed", 321, '{"model":"claude"}');

      const insertedStudy = database.db
        .query("SELECT siss_id, citekey, source, title FROM studies WHERE siss_id = ?;")
        .get("SISS-001") as {
        siss_id: string;
        citekey: string;
        source: string;
        title: string;
      };

      expect(insertedStudy).toEqual({
        siss_id: "SISS-001",
        citekey: "smith2023ashwagandha",
        source: "manual",
        title: "Ashwagandha Trial",
      });

      const dequeuedJob = database.db
        .query(
          "SELECT siss_id, stage, status, priority, ai_window_required FROM jobs ORDER BY priority DESC, created_at ASC LIMIT 1;",
        )
        .get() as {
        siss_id: string;
        stage: string;
        status: string;
        priority: number;
        ai_window_required: number;
      };

      expect(dequeuedJob).toEqual({
        siss_id: "SISS-001",
        stage: "summarize",
        status: "queued",
        priority: 10,
        ai_window_required: 1,
      });

      const stageLog = database.db
        .query(
          "SELECT siss_id, stage, status, duration_ms, metadata FROM job_stage_log WHERE siss_id = ? ORDER BY id DESC LIMIT 1;",
        )
        .get("SISS-001") as {
        siss_id: string;
        stage: string;
        status: string;
        duration_ms: number;
        metadata: string;
      };

      expect(stageLog).toEqual({
        siss_id: "SISS-001",
        stage: "summarize",
        status: "completed",
        duration_ms: 321,
        metadata: '{"model":"claude"}',
      });

      database.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
