# 02 — Pipeline & Queue

**Version:** 0.4 | **Status:** Active (updated for v0.3 data contract)
**Depends on:** 00-architecture-overview, 01-schema-vault-design
**Consumed by:** 03-zotero-sync, 04-pdf-parsing, 05-ai-skills (they implement stages)

---

## 1. Purpose

This spec defines the orchestration layer: how studies move through pipeline stages, how jobs are queued and scheduled, how AI processing respects time windows, and how errors are handled and recovered.

## 2. Pipeline as State Machine

Each study tracks granular step statuses. A study can be "partially complete" without assuming all earlier steps were complete.

```
ingest
  → zotero_sync
  → pdf_fetch
  → fulltext.marker
  → fulltext.docling      (usually skipped in MVP)
  → summarize
  → classify
  → vault_write
  → bases_sync
```

Each step has its own status: `pending | queued | processing | complete | skipped | failed | blocked`.
Overall state is derived as `pipeline_overall`:
- `not_started` — no step completed
- `in_progress` — at least one step in flight, no unresolved failures
- `needs_attention` — at least one step failed/blocked
- `complete` — required steps complete (optional steps may be skipped)

### Stage Transitions
- Forward: each stage completion triggers the next
- Skip: `zotero_sync` skipped if `zotero.enabled: false`; `fulltext.docling` skipped if provider disabled
- Rerun: any stage can be rerun via `rhizome process --stage X`
- AI gate: `summarize`/`classify` respect AI windows
- Fallback path: `summarize` may run with abstract-only input if full-text steps are skipped/failed

### Stage Independence
Each stage reads from the StudyRecord (SQLite + frontmatter) and writes its output back. Stages don't call each other directly — the pipeline orchestrator manages transitions.

### Single-Writer Execution (Project Policy)
Rhizome uses strict single-writer enforcement for all mutating operations:
- One mutating command at a time (`sync`, `process`, `process`, `retry`, `taxonomy apply`, `taxonomy approve/reject`)
- Global lock path: `.siss/locks/mutator.lock`
- Lock metadata includes: `pid`, `command`, `acquired_at`, `heartbeat_at`
- Read-only commands (`status`, `list`, `audit`) do not acquire the lock
- If a live lock exists, the command exits with a clear "writer already active" error

## 3. SQLite Schema

### `studies` table (registry)
```sql
CREATE TABLE studies (
  rhizome_id TEXT PRIMARY KEY,
  citekey TEXT UNIQUE NOT NULL,
  title TEXT,
  doi TEXT,
  pmid TEXT,
  zotero_key TEXT,
  source TEXT NOT NULL,                  -- zotero | bibtex | manual | api
  pipeline_overall TEXT NOT NULL DEFAULT 'not_started',
  pipeline_steps_json TEXT NOT NULL DEFAULT '{}',
  pipeline_error TEXT,
  -- v0.3 additions
  zotero_version INTEGER,
  zotero_sync_status TEXT DEFAULT 'active',
  zotero_tags_snapshot TEXT,             -- JSON: for future merge logic
  tombstone BOOLEAN DEFAULT false,
  tombstone_reason TEXT,
  tombstone_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_studies_pipeline ON studies(pipeline_overall);
CREATE INDEX idx_studies_doi ON studies(doi);
CREATE INDEX idx_studies_pmid ON studies(pmid);
CREATE INDEX idx_studies_zotero ON studies(zotero_key);
```

> **v0.3 note:** `siss_id` renamed to `rhizome_id`. Zotero ops fields (`zotero_version`, `zotero_sync_status`) moved from `pipeline_steps_json` to proper columns. Tombstone fields replace the `removed_upstream_*` fields that were previously embedded in step JSON.

### `jobs` table (queue)
```sql
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rhizome_id TEXT NOT NULL REFERENCES studies(rhizome_id),
  stage TEXT NOT NULL,                   -- PipelineStep value
  status TEXT NOT NULL DEFAULT 'queued', -- queued | processing | complete | error | paused | skipped
  priority INTEGER NOT NULL DEFAULT 0,  -- higher = sooner
  ai_window_required BOOLEAN DEFAULT false,
  error_message TEXT,
  error_class TEXT,                      -- transient | permanent | null
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  metadata TEXT                          -- JSON: model, skill_version, tokens, etc.
);

CREATE INDEX idx_jobs_status ON jobs(status, priority DESC);
CREATE INDEX idx_jobs_rhizome ON jobs(rhizome_id, stage);
```

### `job_stage_log` table (audit)
```sql
CREATE TABLE job_stage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rhizome_id TEXT NOT NULL REFERENCES studies(rhizome_id),
  stage TEXT NOT NULL,
  status TEXT NOT NULL,                  -- started | completed | failed | skipped
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  metadata TEXT                          -- JSON: any stage-specific data
);

CREATE INDEX idx_log_rhizome ON job_stage_log(rhizome_id);
```

### `zotero_sync_state` table (Resolves F05)
```sql
CREATE TABLE zotero_sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1,     -- singleton row
  library_version INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  last_success_at TEXT,
  items_synced INTEGER DEFAULT 0,
  sync_error TEXT,
  CHECK (id = 1)                        -- enforce singleton
);
```

### `config_meta` table
```sql
CREATE TABLE config_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Stores: config_version, last_migration, db_schema_version
```

### `pipeline_runs` table (v0.3 — detailed run history)
```sql
CREATE TABLE pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rhizome_id TEXT NOT NULL REFERENCES studies(rhizome_id),
  run_id TEXT UNIQUE NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  retries INTEGER DEFAULT 0,
  skip_reason TEXT,
  error TEXT,
  model TEXT,
  skill TEXT
);
CREATE INDEX idx_pipeline_runs_study ON pipeline_runs(rhizome_id);
CREATE INDEX idx_pipeline_runs_run ON pipeline_runs(run_id);
```

> **v0.3 note:** `pipeline_runs` captures detailed per-step execution history for audit, reprocessing, and skill-version queries. The `pipeline_steps_json` column on `studies` remains as the live pipeline state; `pipeline_runs` is the append-only history. Frontmatter receives only the 6 surface fields (`has_*`, `pipeline_status`, `pipeline_error`, `last_pipeline_run`).

## 4. Pipeline Orchestrator

```typescript
class PipelineOrchestrator {
  // Process all queued non-AI stages
  async processNonAI(): Promise<ProcessResult>;

  // Process AI stages (respects windows unless force=true)
  async processAI(options?: { force?: boolean; batchSize?: number }): Promise<ProcessResult>;

  // Enqueue a new study
  async enqueue(record: StudyRecord, options?: { priority?: number }): Promise<void>;

  // Requeue a specific stage for existing study
  async reprocess(rhizomeId: string, stage: PipelineStep, options?: { cascade?: boolean }): Promise<void>;

  // Bulk reprocess by filter
  async bulkReprocess(filter: ReprocessFilter): Promise<{ count: number; dryRun: boolean }>;

  // Get next job to process (respects AI windows)
  async getNextJob(aiWindowActive: boolean): Promise<Job | null>;

  // Acquire global mutation lock (required for all mutating commands)
  async acquireWriterLock(command: string): Promise<LockHandle>;
}
```

### Lock Lifecycle
```text
1. Command starts and attempts to create lockfile atomically
2. If lock exists:
   - If heartbeat is fresh: fail fast
   - If stale (> lock_stale_minutes): require explicit --force clear, then retry
3. While running: update heartbeat every 10s
4. On success/failure: release lock in finally block
```

### Processing Loop
```
1. Dequeue next job (ordered by priority, then created_at)
2. Check: is this an AI stage AND we're outside AI window?
   → Yes: skip, leave in queue
   → No: proceed
3. Update job status to 'processing'
4. Execute stage handler
5. On success:
   → Update job status to 'complete'
   → Update `pipeline_steps_json[stage]`
   → Recompute and persist `pipeline_overall`
   → Update frontmatter surface fields (`has_*`, `pipeline_status`) on next vault_write
   → Enqueue next stage (if any)
   → Log to job_stage_log
6. On failure:
   → Increment retry_count
   → If retry_count < max_retries: re-queue with backoff
   → If retry_count >= max_retries: set status 'paused'
   → Log error to job_stage_log
   → Update `pipeline_steps_json[stage]` + `pipeline_error`
   → Recompute `pipeline_overall` (`needs_attention` when unresolved)
```

## 5. AI Time Windows (Resolves F06)

### Configuration
```yaml
ai:
  windows:
    - "04:00-06:00"
    - "17:00-19:00"
    - "23:00-01:00"     # cross-midnight
  timezone: "Europe/Oslo"       # explicit timezone, required
  batch_size: 20                # max studies per window
  cooldown_seconds: 30          # pause between AI invocations
```

### Window Evaluation
```typescript
function isInAIWindow(config: AIConfig): boolean {
  const now = DateTime.now().setZone(config.timezone);
  const currentMinutes = now.hour * 60 + now.minute;

  for (const window of config.windows) {
    const [start, end] = parseWindow(window);
    if (start < end) {
      // Normal window: 17:00-19:00
      if (currentMinutes >= start && currentMinutes < end) return true;
    } else {
      // Cross-midnight: 23:00-01:00
      if (currentMinutes >= start || currentMinutes < end) return true;
    }
  }
  return false;
}
```

### Timezone and DST (Resolves F06)
- All window times are in the configured timezone (not UTC)
- Use `luxon` or `Temporal` (if available in Bun) for timezone-aware time handling
- DST transitions: if a window boundary falls during a DST change, the window is evaluated using the local clock — no special handling needed because we check "is it within the window right now" rather than computing absolute intervals
- Cross-midnight windows work by checking "current >= start OR current < end"

### Batch Processing
```
1. Check: is current time within any AI window?
2. If yes: dequeue up to batch_size AI jobs
3. Process sequentially with cooldown_seconds between each
4. After batch: check if still in window
5. If window expired mid-batch: stop, remaining jobs stay queued
```

## 6. Error Recovery

### Error Classification
Failures are classified to prevent wasteful retries:

| Class | Examples | Default max_retries | Handling |
|---|---|---|---|
| Transient | Timeout, rate limit (429), usage exhausted, network error | 3 (non-AI), 1 (AI) | Retry with backoff, then pause |
| Permanent | Corrupted PDF, invalid schema, persistent parse failure | 0 | Mark `paused` immediately, log reason |

AI stages (`summarize`, `classify`) default to `max_retries: 1` — retry once in the next window, then pause. This avoids burning tokens on likely-failing inputs. Non-AI stages default to `max_retries: 3`.

On max retries exceeded: set job status to `paused`, update `pipeline_overall` to `needs_attention`, surface in `rhizome status`.

### Common Failure Modes
| Failure | Stage | Class | Handling |
|---|---|---|---|
| Zotero API 429 (rate limit) | zotero_sync | Transient | Retry with backoff |
| PDF not found anywhere | pdf_fetch | Permanent | Mark `pdf_available: false`, keep fulltext steps skipped, queue summarize (abstract-only) |
| Parser crash (Marker) | parse | Transient | Retry; on persistent failure, skip fulltext and summarize from abstract |
| Claude Code timeout | summarize/classify | Transient | Retry in next AI window |
| Claude Code usage exhausted | summarize/classify | Transient | Retry in next AI window |
| Claude Code parse failure | summarize/classify | Permanent | Save raw output to `_assets/{citekey}/debug/`, mark error |
| Disk full | vault_write | Permanent | Fail loudly, notify user |

## 7. Reprocessing System

### Selective Reprocess
```bash
# Rerun summary for one study (compat selector retained)
rhizome reprocess --citekey smith2023ashwagandha --stage summarize

# Queue all studies missing summaries
rhizome reprocess --filter "has_summary=false"

# Rerun classifier for studies using old skill version
rhizome reprocess --stage classify --skill-lt 2.0

# Rerun with cascade (summary reprocess also triggers re-classify)
rhizome reprocess --stage summarize --skill-lt 1.3 --cascade

# Dry run
rhizome reprocess --stage summarize --skill-lt 1.3 --dry-run
```

### Filter Syntax
Filters query the SQLite `studies` + `pipeline_runs` state (not frontmatter):
- `--citekey X` — single study (compat mode in first build)
- `--stage X` — which stage to rerun
- `--skill-lt X` — studies where `summary_skill`/`classifier_skill` version part is < X
- `--collection X` — studies in a specific Zotero collection
- `--filter "has_summary=false"` — queue based on pipeline surface fields
- `--filter "pipeline_overall = 'needs_attention'"` — advanced raw SQL WHERE clause

### Cascade Rules
When `--cascade` is set:
- Summarize reprocess → enqueue classify after summarize completes
- Classify reprocess → enqueue vault_write after classify completes
- PDF reprocess → enqueue fulltext → summarize → classify → vault_write

## 8. Bulk Import Handling

For the initial Zotero library import (~600 studies):

```
Phase 1: Ingest (immediate)
  → Pull all Zotero items
  → Create StudyRecord for each
  → Insert into SQLite with `pipeline_overall = in_progress` + `ingest = complete`

Phase 2: PDF + Parse (immediate, sequential)
  → For each study: attempt PDF fetch → run Marker
  → Studies without PDF: keep fulltext steps skipped, queue summarize (abstract-only)
  → Rate limit: 1 request/second for external PDF sources

Phase 3: AI Processing (windowed)
  → Studies have `summarize = queued`
  → Processed in batches during AI windows
  → At 20 studies/window, 3 windows/day = 60 studies/day
  → Full library: ~10 days of AI processing

Phase 4: Vault Write (after each AI completion)
  → Each study gets its note written as soon as AI stages complete
  → Bases views regenerated after every N writes (configurable, default 10)
```

### Priority System
- Default priority: 0
- Manually added studies: priority 10 (processed first)
- Bulk import: priority 0
- Reprocess jobs: priority 5
- `rhizome add --priority high` sets priority 10

## 9. Audit Trail

### SQLite (primary, always on)
- `job_stage_log` captures every stage execution with timing
- `studies` table captures current state
- Queryable: `rhizome audit --citekey X` shows full history

### Markdown (optional, configurable)
- `audit_log.md` in `_system/` for human-readable trail
- Appended to, never rewritten
- Configurable: `audit.markdown_log: true/false`
- Format:
```
[2026-03-25 17:30:01] INGEST      smith2023ashwagandha  source=zotero
[2026-03-25 17:30:02] PDF         smith2023ashwagandha  source=unpaywall  status=success
[2026-03-25 17:30:03] SUMMARIZE   smith2023ashwagandha  status=complete
[2026-03-25 17:30:04] CLASSIFY    smith2023ashwagandha  status=complete
```

## 10. Implementation Steps

### Step 1 (Phase 1): Basic Queue
- Create SQLite schema (studies + jobs + job_stage_log + zotero_sync_state)
- Implement job enqueue/dequeue/update
- Implement global single-writer lock acquisition/release
- Implement basic pipeline orchestrator (sequential, no AI windows)
- Test: enqueue a study, process through ingest → zotero_sync → vault_write with correct per-step statuses

### Step 2 (Phase 2): AI Window Scheduling
- Implement time window parser and evaluator
- Implement AI-aware job dequeuing
- Implement batch processing with cooldown
- Test: verify jobs are held when outside AI windows

### Step 3 (Phase 2-3): Error Recovery
- Implement error classification (transient vs permanent)
- Implement retry logic with max_retries and error_class
- Implement error state transitions
- Implement `rhizome retry` command
- Test: simulate failures at each stage, verify recovery

### Step 4 (Phase 3): Reprocessing
- Implement process filter queries
- Implement cascade logic
- Implement dry-run mode
- Test: update a skill version, verify correct studies are identified for reprocessing

### Testing Strategy
- In-memory SQLite for unit tests
- Fixture studies with known pipeline states
- Time window tests with mocked clock
- Integration tests: end-to-end pipeline with stubbed stage handlers
