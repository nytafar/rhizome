export const SCHEMA_VERSION = 4;

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

const MIGRATION_002_SQL: string[] = [
  "PRAGMA foreign_keys = OFF;",
  `
  CREATE TABLE studies_new (
    rhizome_id TEXT PRIMARY KEY,
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
  `,
  `
  INSERT INTO studies_new (
    rhizome_id,
    citekey,
    title,
    doi,
    pmid,
    zotero_key,
    source,
    pipeline_overall,
    pipeline_steps_json,
    pipeline_error,
    created_at,
    updated_at
  )
  SELECT
    siss_id,
    citekey,
    title,
    doi,
    pmid,
    zotero_key,
    source,
    pipeline_overall,
    pipeline_steps_json,
    pipeline_error,
    created_at,
    updated_at
  FROM studies;
  `,
  `
  CREATE TABLE jobs_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rhizome_id TEXT NOT NULL REFERENCES studies_new(rhizome_id),
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
  `,
  `
  INSERT INTO jobs_new (
    id,
    rhizome_id,
    stage,
    status,
    priority,
    ai_window_required,
    error_message,
    error_class,
    retry_count,
    max_retries,
    created_at,
    started_at,
    completed_at,
    metadata
  )
  SELECT
    id,
    siss_id,
    stage,
    status,
    priority,
    ai_window_required,
    error_message,
    error_class,
    retry_count,
    max_retries,
    created_at,
    started_at,
    completed_at,
    metadata
  FROM jobs;
  `,
  `
  CREATE TABLE job_stage_log_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rhizome_id TEXT NOT NULL REFERENCES studies_new(rhizome_id),
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    metadata TEXT
  );
  `,
  `
  INSERT INTO job_stage_log_new (
    id,
    rhizome_id,
    stage,
    status,
    started_at,
    completed_at,
    duration_ms,
    metadata
  )
  SELECT
    id,
    siss_id,
    stage,
    status,
    started_at,
    completed_at,
    duration_ms,
    metadata
  FROM job_stage_log;
  `,
  "DROP TABLE job_stage_log;",
  "DROP TABLE jobs;",
  "DROP TABLE studies;",
  "ALTER TABLE studies_new RENAME TO studies;",
  "ALTER TABLE jobs_new RENAME TO jobs;",
  "ALTER TABLE job_stage_log_new RENAME TO job_stage_log;",
  "CREATE INDEX IF NOT EXISTS idx_studies_pipeline ON studies(pipeline_overall);",
  "CREATE INDEX IF NOT EXISTS idx_studies_doi ON studies(doi);",
  "CREATE INDEX IF NOT EXISTS idx_studies_pmid ON studies(pmid);",
  "CREATE INDEX IF NOT EXISTS idx_studies_zotero ON studies(zotero_key);",
  "CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority DESC);",
  "CREATE INDEX IF NOT EXISTS idx_jobs_rhizome ON jobs(rhizome_id, stage);",
  "CREATE INDEX IF NOT EXISTS idx_log_rhizome ON job_stage_log(rhizome_id);",
  "PRAGMA foreign_keys = ON;",
];

const MIGRATION_003_SQL: string[] = [
  "ALTER TABLE studies ADD COLUMN zotero_version INTEGER;",
  "ALTER TABLE studies ADD COLUMN zotero_sync_status TEXT NOT NULL DEFAULT 'active';",
  "ALTER TABLE studies ADD COLUMN removed_upstream_at TEXT;",
  "ALTER TABLE studies ADD COLUMN removed_upstream_reason TEXT;",
  "ALTER TABLE studies ADD COLUMN source_collections_json TEXT;",
  "CREATE INDEX IF NOT EXISTS idx_studies_zotero_sync_status ON studies(zotero_sync_status);",
];

const MIGRATION_004_SQL: string[] = [
  `
  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rhizome_id TEXT NOT NULL REFERENCES studies(rhizome_id),
    run_id TEXT NOT NULL,
    step TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    skip_reason TEXT,
    error TEXT,
    model TEXT,
    skill TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  "CREATE INDEX IF NOT EXISTS idx_pipeline_runs_study ON pipeline_runs(rhizome_id);",
  "CREATE INDEX IF NOT EXISTS idx_pipeline_runs_run ON pipeline_runs(run_id);",
  "CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);",
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
  {
    version: 2,
    statements: MIGRATION_002_SQL,
  },
  {
    version: 3,
    statements: MIGRATION_003_SQL,
  },
  {
    version: 4,
    statements: MIGRATION_004_SQL,
  },
];
