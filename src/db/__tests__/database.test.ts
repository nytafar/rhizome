import { describe, expect, test } from "bun:test";
import { Database as BunSQLiteDatabase } from "bun:sqlite";
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
        "pipeline_runs",
        "studies",
        "taxonomy_propagation_checkpoints",
        "taxonomy_proposal_decisions",
        "zotero_sync_state",
      ]);

      const schemaVersion = database.db
        .query("SELECT value FROM config_meta WHERE key = 'db_schema_version';")
        .get() as { value: string };

      expect(schemaVersion.value).toBe("5");

      const studiesColumns = database.db.query("PRAGMA table_info(studies);").all() as Array<{ name: string }>;
      const jobsColumns = database.db.query("PRAGMA table_info(jobs);").all() as Array<{ name: string }>;
      const logColumns = database.db.query("PRAGMA table_info(job_stage_log);").all() as Array<{ name: string }>;
      const decisionColumns = database.db
        .query("PRAGMA table_info(taxonomy_proposal_decisions);")
        .all() as Array<{ name: string }>;
      const checkpointColumns = database.db
        .query("PRAGMA table_info(taxonomy_propagation_checkpoints);")
        .all() as Array<{ name: string }>;

      expect(studiesColumns.some((column) => column.name === "rhizome_id")).toBe(true);
      expect(studiesColumns.some((column) => column.name === "zotero_version")).toBe(true);
      expect(studiesColumns.some((column) => column.name === "zotero_sync_status")).toBe(true);
      expect(studiesColumns.some((column) => column.name === "removed_upstream_at")).toBe(true);
      expect(studiesColumns.some((column) => column.name === "removed_upstream_reason")).toBe(true);
      expect(studiesColumns.some((column) => column.name === "source_collections_json")).toBe(true);
      expect(jobsColumns.some((column) => column.name === "rhizome_id")).toBe(true);
      expect(logColumns.some((column) => column.name === "rhizome_id")).toBe(true);
      expect(decisionColumns.some((column) => column.name === "proposal_id")).toBe(true);
      expect(decisionColumns.some((column) => column.name === "operation_type")).toBe(true);
      expect(decisionColumns.some((column) => column.name === "decision_status")).toBe(true);
      expect(decisionColumns.some((column) => column.name === "decided_at")).toBe(true);
      expect(checkpointColumns.some((column) => column.name === "checkpoint_id")).toBe(true);
      expect(checkpointColumns.some((column) => column.name === "proposal_id")).toBe(true);
      expect(checkpointColumns.some((column) => column.name === "status")).toBe(true);
      expect(checkpointColumns.some((column) => column.name === "cursor_json")).toBe(true);
      expect(checkpointColumns.some((column) => column.name === "last_error")).toBe(true);

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
          INSERT INTO studies (rhizome_id, citekey, source, title)
          VALUES (?, ?, ?, ?);
        `,
        )
        .run("RHIZOME-001", "smith2023ashwagandha", "manual", "Ashwagandha Trial");

      database.db
        .query(
          `
          INSERT INTO jobs (rhizome_id, stage, status, priority, ai_window_required)
          VALUES (?, ?, ?, ?, ?);
        `,
        )
        .run("RHIZOME-001", "summarize", "queued", 10, true);

      database.db
        .query(
          `
          INSERT INTO job_stage_log (rhizome_id, stage, status, started_at, completed_at, duration_ms, metadata)
          VALUES (?, ?, ?, datetime('now'), datetime('now'), ?, ?);
        `,
        )
        .run("RHIZOME-001", "summarize", "completed", 321, '{"model":"claude"}');

      const insertedStudy = database.db
        .query("SELECT rhizome_id, citekey, source, title FROM studies WHERE rhizome_id = ?;")
        .get("RHIZOME-001") as {
        rhizome_id: string;
        citekey: string;
        source: string;
        title: string;
      };

      expect(insertedStudy).toEqual({
        rhizome_id: "RHIZOME-001",
        citekey: "smith2023ashwagandha",
        source: "manual",
        title: "Ashwagandha Trial",
      });

      const dequeuedJob = database.db
        .query(
          "SELECT rhizome_id, stage, status, priority, ai_window_required FROM jobs ORDER BY priority DESC, created_at ASC LIMIT 1;",
        )
        .get() as {
        rhizome_id: string;
        stage: string;
        status: string;
        priority: number;
        ai_window_required: number;
      };

      expect(dequeuedJob).toEqual({
        rhizome_id: "RHIZOME-001",
        stage: "summarize",
        status: "queued",
        priority: 10,
        ai_window_required: 1,
      });

      const stageLog = database.db
        .query(
          "SELECT rhizome_id, stage, status, duration_ms, metadata FROM job_stage_log WHERE rhizome_id = ? ORDER BY id DESC LIMIT 1;",
        )
        .get("RHIZOME-001") as {
        rhizome_id: string;
        stage: string;
        status: string;
        duration_ms: number;
        metadata: string;
      };

      expect(stageLog).toEqual({
        rhizome_id: "RHIZOME-001",
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

  test("migrates v1 siss_id schema to latest rhizome_id schema with Zotero operational columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rhizome-db-migrate-"));
    const dbPath = join(dir, "rhizome.sqlite");

    try {
      const legacyDb = new BunSQLiteDatabase(dbPath, { create: true, strict: true });
      legacyDb.exec("PRAGMA foreign_keys = ON;");

      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS studies (
          siss_id TEXT PRIMARY KEY,
          citekey TEXT UNIQUE NOT NULL,
          title TEXT,
          doi TEXT,
          pmid TEXT,
          zotero_key TEXT,
          source TEXT NOT NULL,
          pipeline_overall TEXT NOT NULL DEFAULT 'not_started',
          pipeline_steps_json TEXT NOT NULL DEFAULT '{}',
          pipeline_error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          siss_id TEXT NOT NULL REFERENCES studies(siss_id),
          stage TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          priority INTEGER NOT NULL DEFAULT 0,
          ai_window_required BOOLEAN DEFAULT false,
          error_message TEXT,
          error_class TEXT,
          retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 3,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          completed_at TEXT,
          metadata TEXT
        );
      `);
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS job_stage_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          siss_id TEXT NOT NULL REFERENCES studies(siss_id),
          stage TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          duration_ms INTEGER,
          metadata TEXT
        );
      `);
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS zotero_sync_state (
          id INTEGER PRIMARY KEY DEFAULT 1,
          library_version INTEGER NOT NULL DEFAULT 0,
          last_sync_at TEXT,
          last_success_at TEXT,
          items_synced INTEGER DEFAULT 0,
          sync_error TEXT,
          CHECK (id = 1)
        );
      `);
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS config_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      legacyDb
        .query("INSERT INTO studies (siss_id, citekey, source, title) VALUES (?, ?, ?, ?);")
        .run("SISS-LEGACY-1", "legacy2024trial", "manual", "Legacy Study");
      legacyDb
        .query("INSERT INTO jobs (siss_id, stage, status, priority) VALUES (?, ?, ?, ?);")
        .run("SISS-LEGACY-1", "summarize", "queued", 3);
      legacyDb
        .query("INSERT INTO job_stage_log (siss_id, stage, status, duration_ms) VALUES (?, ?, ?, ?);")
        .run("SISS-LEGACY-1", "summarize", "completed", 123);
      legacyDb
        .query(
          "INSERT INTO config_meta (key, value, updated_at) VALUES ('db_schema_version', '1', datetime('now'));",
        )
        .run();

      legacyDb.close(false);

      const database = new Database({ path: dbPath });
      database.init();

      const schemaVersion = database.db
        .query("SELECT value FROM config_meta WHERE key = 'db_schema_version';")
        .get() as { value: string };
      expect(schemaVersion.value).toBe("5");

      const migratedStudy = database.db
        .query(
          `
          SELECT rhizome_id, citekey, title, zotero_version, zotero_sync_status, removed_upstream_at, removed_upstream_reason, source_collections_json
          FROM studies
          WHERE rhizome_id = ?;
          `,
        )
        .get("SISS-LEGACY-1") as {
        rhizome_id: string;
        citekey: string;
        title: string;
        zotero_version: number | null;
        zotero_sync_status: string;
        removed_upstream_at: string | null;
        removed_upstream_reason: string | null;
        source_collections_json: string | null;
      };
      expect(migratedStudy).toEqual({
        rhizome_id: "SISS-LEGACY-1",
        citekey: "legacy2024trial",
        title: "Legacy Study",
        zotero_version: null,
        zotero_sync_status: "active",
        removed_upstream_at: null,
        removed_upstream_reason: null,
        source_collections_json: null,
      });

      const migratedJob = database.db
        .query("SELECT rhizome_id, stage, status FROM jobs WHERE rhizome_id = ? LIMIT 1;")
        .get("SISS-LEGACY-1") as { rhizome_id: string; stage: string; status: string };
      expect(migratedJob).toEqual({
        rhizome_id: "SISS-LEGACY-1",
        stage: "summarize",
        status: "queued",
      });

      const migratedLog = database.db
        .query("SELECT rhizome_id, stage, status FROM job_stage_log WHERE rhizome_id = ? LIMIT 1;")
        .get("SISS-LEGACY-1") as { rhizome_id: string; stage: string; status: string };
      expect(migratedLog).toEqual({
        rhizome_id: "SISS-LEGACY-1",
        stage: "summarize",
        status: "completed",
      });

      const foreignKeyIssues = database.db.query("PRAGMA foreign_key_check;").all() as unknown[];
      expect(foreignKeyIssues).toHaveLength(0);

      database.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
