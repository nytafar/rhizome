export const SCHEMA_VERSION = 1;

const CREATE_STUDIES_TABLE_SQL = `
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
`;

const CREATE_STUDIES_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_studies_pipeline ON studies(pipeline_overall);",
  "CREATE INDEX IF NOT EXISTS idx_studies_doi ON studies(doi);",
  "CREATE INDEX IF NOT EXISTS idx_studies_pmid ON studies(pmid);",
  "CREATE INDEX IF NOT EXISTS idx_studies_zotero ON studies(zotero_key);",
];

const CREATE_JOBS_TABLE_SQL = `
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
`;

const CREATE_JOBS_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority DESC);",
  "CREATE INDEX IF NOT EXISTS idx_jobs_siss ON jobs(siss_id, stage);",
];

const CREATE_JOB_STAGE_LOG_TABLE_SQL = `
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
`;

const CREATE_JOB_STAGE_LOG_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_log_siss ON job_stage_log(siss_id);",
];

const CREATE_ZOTERO_SYNC_STATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS zotero_sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  library_version INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  last_success_at TEXT,
  items_synced INTEGER DEFAULT 0,
  sync_error TEXT,
  CHECK (id = 1)
);
`;

const CREATE_CONFIG_META_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS config_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const MIGRATION_001_SQL: string[] = [
  CREATE_STUDIES_TABLE_SQL,
  ...CREATE_STUDIES_INDEXES_SQL,
  CREATE_JOBS_TABLE_SQL,
  ...CREATE_JOBS_INDEXES_SQL,
  CREATE_JOB_STAGE_LOG_TABLE_SQL,
  ...CREATE_JOB_STAGE_LOG_INDEXES_SQL,
  CREATE_ZOTERO_SYNC_STATE_TABLE_SQL,
  CREATE_CONFIG_META_TABLE_SQL,
];

export interface SchemaMigration {
  version: number;
  statements: string[];
}

export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    statements: MIGRATION_001_SQL,
  },
];
