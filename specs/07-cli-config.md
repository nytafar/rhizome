# 07 — CLI & Configuration

**Version:** 0.2 | **Status:** Draft for review
**Depends on:** All other specs (CLI is the interface to everything)
**Consumed by:** Users, agents

---

## 1. Purpose

This spec defines the user-facing CLI, the configuration schema, the setup flow, and how agents interact with Rhizome. The CLI is the **only** interface in MVP — no HTTP API, no MCP server.

## 2. CLI Design Principles

- **One binary, subcommands**: `rhizome <command> [options]`
- **Human and agent friendly**: same commands work whether typed by you or invoked by Claude Code
- **Verbose by default, quiet option**: show progress unless `--quiet` flag
- **Dry-run support**: destructive/bulk operations support `--dry-run`
- **JSON output option**: `--json` flag on any command for machine parsing
- **Strict single-writer mutation**: only one mutating command may run at once (lockfile enforced)

## 3. Command Reference

### Setup
```bash
rhizome init                              # interactive setup wizard
rhizome init --vault /path/to/vault \     # non-interactive
  --zotero-user 12345 \
  --zotero-key-env ZOTERO_API_KEY

rhizome config show                       # display current config
rhizome config set <key> <value>          # set a config value
rhizome config validate                   # check config is valid
```

### Study Management
```bash
rhizome add --doi 10.1234/xyz             # add by DOI
rhizome add --pmid 37291847               # add by PMID
rhizome add --doi 10.1234/xyz \
  --collection "Adaptogens" \
  --priority high                       # add with options

rhizome status                            # queue overview: counts per stage
rhizome status --citekey smith2023ashwa   # single study detail
rhizome status --citekey smith2023ashwa --granular   # per-step status detail
rhizome status --overall needs_attention  # all studies requiring intervention
rhizome status --json                     # machine-readable output

rhizome list                              # list all studies
rhizome list --filter "year > 2022"       # filtered list
rhizome list --format table               # formatted table output
```

### Sync
```bash
rhizome sync zotero                       # pull changes from Zotero
rhizome sync zotero --full                # force full sync (reset delta)
rhizome sync zotero --collection "Adaptogens"  # sync specific collection

# Phase 5:
# rhizome sync vault                      # push new vault studies to Zotero
# rhizome sync all                        # bidirectional
```

### Pipeline Processing
```bash
rhizome process                           # run all non-AI stages for queued studies
rhizome process --ai                      # run AI stages (respects time windows)
rhizome process --ai --now                # ignore time windows
rhizome process --ai --batch 5            # limit to 5 studies this run
rhizome process --citekey smith2023ashwa  # process specific study only

# Mutating commands acquire global writer lock automatically
# and fail fast if another mutating run is active.

rhizome reprocess --citekey X --stage summary              # rerun one stage
rhizome reprocess --stage summary --skill-version-lt 1.3   # bulk rerun
rhizome reprocess --stage classify --collection "Adaptogens"
rhizome reprocess --stage summary --cascade                 # summary → re-classify
rhizome reprocess --stage summary --dry-run                 # preview what would run
```

### Error Recovery
```bash
rhizome retry --citekey smith2023ashwa    # retry failed study
rhizome retry --all-failed                # retry all failed
rhizome retry --all-failed --reset-retries  # reset retry count and retry
```

### Lock Management
```bash
rhizome lock status                       # show current writer lock holder
rhizome lock clear --force                # clear stale writer lock
```

### Taxonomy
```bash
rhizome taxonomy status                   # overview: confirmed, pending, deprecated
rhizome taxonomy stats                    # top values, growth over time
rhizome taxonomy review                   # show pending proposals
rhizome taxonomy approve --id M1          # approve specific proposal
rhizome taxonomy approve --id S1 \
  --values "memory,executive function"  # approve split with custom values
rhizome taxonomy reject --id R2 \
  --note "too early to rename"          # reject with note
rhizome taxonomy approve --all-auto       # approve all auto-promotions
rhizome taxonomy suggest \
  --group delivery_mechanism \
  --values "liposomal,standard"         # suggest new group/values
rhizome taxonomy apply                    # apply approved changes (propagate)
rhizome taxonomy apply --resume           # resume interrupted propagation
```

### Import (Phase 5)
```bash
rhizome import --source bibtex --file refs.bib
rhizome import --scan                     # process all files in _imports/
```

### Audit
```bash
rhizome audit --citekey smith2023ashwa    # full history for one study
rhizome audit --stage summary --last 10   # last 10 summary operations
rhizome audit --errors --last 20          # last 20 errors
```

## 4. Configuration Schema

### `config.yaml` (with zod validation)

```yaml
# === Meta ===
config_version: 1                       # for schema migration

# === Vault ===
vault:
  path: "/path/to/vault"
  research_root: "Research"
  studies_folder: "studies"
  assets_folder: "_assets"
  study_notes_folder: "study-notes"
  imports_folder: "_imports"
  system_folder: "_system"

# === Zotero ===
zotero:
  enabled: true
  user_id: "12345"
  api_key: "env:ZOTERO_API_KEY"         # supports env var references
  collections: []                        # empty = all
  skip_item_types:
    - "note"
    - "attachment"
    - "annotation"
    - "webpage"

# === PDF ===
pdf:
  sources:
    - "zotero"
    - "unpaywall"
    - "europepmc"
  unpaywall_email: "your@email.com"
  download_timeout_ms: 30000
  max_file_size_mb: 100

# === PDF Parser ===
parser:
  active_provider: "marker"
  marker:
    version: "1.6.0"
    timeout_ms: 300000
    force_ocr: false
    python_env: ".siss-env"

# === AI ===
ai:
  windows:
    - "04:00-06:00"
    - "17:00-19:00"
    - "23:00-01:00"
  timezone: "Europe/Oslo"
  batch_size: 20
  cooldown_seconds: 30
  strategy: "piped"                       # piped | two_pass | single_pass
  max_input_tokens: 80000                 # per-study fulltext truncation limit
  claude_binary: "claude"
  summarizer:
    skill_file: "summarizer.md"
    max_turns: 10
    timeout_ms: 300000
  classifier:
    skill_file: "classifier.md"
    max_turns: 5
    timeout_ms: 180000

# === Taxonomy ===
taxonomy:
  auto_promote_threshold: 3
  deprecation_days: 90
  max_pending_before_review: 20
  groups:
    - name: "therapeutic_areas"
      description: "Primary therapeutic/health areas"
    - name: "mechanisms"
      description: "Biological mechanisms of action"
    - name: "indications"
      description: "Clinical or product indications"
    - name: "contraindications"
      description: "Known contraindications"
    - name: "drug_interactions"
      description: "Known drug interactions"
    - name: "research_gaps"
      description: "Identified gaps in research"

# === Pipeline ===
pipeline:
  max_retries: 3
  single_writer: true
  lock_path: ".siss/locks/mutator.lock"
  lock_stale_minutes: 15
  ai_required_stages:
    - "summarize"
    - "classify"
  skip_stages: []                        # e.g., ["zotero_sync"] if Zotero disabled

# === Audit ===
audit:
  markdown_log: true                     # write _system/audit_log.md
  retain_debug_output: true              # keep raw AI output on parse failure

# === Data ===
data:
  db_path: ".siss/siss.db"              # SQLite database location
  skills_dir: ".siss/skills/"           # skill prompt files (single source of truth for skill location)
```

### Environment Variable Support
Config values prefixed with `env:` are resolved from environment:
```yaml
zotero:
  api_key: "env:ZOTERO_API_KEY"          # reads $ZOTERO_API_KEY
```

### Config Versioning (Resolves F10)
```typescript
const CONFIG_MIGRATIONS: Record<number, (config: any) => any> = {
  // v1 → v2: rename 'agent' → 'ai'
  2: (config) => {
    config.ai = config.agent;
    delete config.agent;
    config.config_version = 2;
    return config;
  },
};

function migrateConfig(config: any): Config {
  while (config.config_version < CURRENT_CONFIG_VERSION) {
    const next = config.config_version + 1;
    const migration = CONFIG_MIGRATIONS[next];
    if (!migration) throw new Error(`No migration for v${next}`);

    // Backup before migration
    writeFileSync(`config.yaml.backup.v${config.config_version}`, ...);

    config = migration(config);
  }
  return validateConfig(config);  // zod validation
}
```

## 5. `rhizome init` Setup Flow

### Interactive Mode
```
$ rhizome init

Welcome to Rhizome — Study Intelligence Sync Service

Step 1/5: Vault Location
  Enter your Obsidian vault path: /Users/lasse/Documents/Vault
  ✓ Vault found at /Users/lasse/Documents/Vault

Step 2/5: Research Folder
  Where should studies live? [Research]: Research
  ✓ Will create Research/studies/, Research/_system/, etc.

Step 3/5: Zotero Integration
  Enable Zotero sync? [Y/n]: Y
  Zotero User ID: 12345
  Zotero API Key: ****
  ✓ Zotero connected (found 612 items)
  Sync specific collections? [all]: Adaptogens, Clinical Trials

Step 4/5: PDF Sources
  Email for Unpaywall API: lasse@nyta.no
  ✓ Unpaywall configured

Step 5/5: AI Configuration
  AI processing windows (comma-separated, 24h format):
    [17:00-19:00, 23:00-01:00, 04:00-06:00]: ↵
  Timezone [Europe/Oslo]: ↵

Setting up Python environment for Marker...
  ✓ uv found
  ✓ Python 3.11 available
  ✓ marker-pdf 1.6.0 installed
  ✓ Marker healthcheck passed

Creating folder structure...
  ✓ Research/studies/
  ✓ Research/studies/_assets/
  ✓ Research/study-notes/
  ✓ Research/_imports/bibtex/done/
  ✓ Research/_system/

Writing config.yaml...
  ✓ Config saved

Creating initial Bases views...
  ✓ Research/_system/studies.base
  ✓ Research/_system/review-queue.base

Rhizome is ready! Next steps:
  rhizome sync zotero              # pull your Zotero library
  rhizome process                  # fetch PDFs and parse to markdown
  rhizome process --ai             # run AI summarization (during your configured windows)
  rhizome status                   # check progress
```

### Non-Interactive Mode
```bash
rhizome init \
  --vault /path/to/vault \
  --research-root Research \
  --zotero-user 12345 \
  --zotero-key-env ZOTERO_API_KEY \
  --zotero-collections "Adaptogens,Clinical Trials" \
  --unpaywall-email lasse@nyta.no \
  --ai-windows "17:00-19:00,23:00-01:00,04:00-06:00" \
  --timezone "Europe/Oslo"
```

## 6. Agent Invocation

Claude Code (or any agent) interacts with Rhizome through the same CLI:

### Claude Code Skill for Rhizome
A Claude Code skill file that describes available commands:
```markdown
# Rhizome Study Management

You have access to a research study management CLI. Use these commands:

## Adding Studies
- `rhizome add --doi {doi}` — add a study by DOI
- `rhizome add --pmid {pmid}` — add by PubMed ID

## Checking Status
- `rhizome status` — queue overview
- `rhizome status --citekey {key}` — single study detail

## Processing
- `rhizome process` — run pending pipeline stages
- `rhizome process --ai --now` — run AI stages immediately

## Taxonomy
- `rhizome taxonomy status` — overview
- `rhizome taxonomy review` — pending proposals
- `rhizome taxonomy approve --id {id}` — approve changes
```

### JSON Output for Agents
Every command supports `--json` for machine-parseable output:
```bash
rhizome status --json
# { "queue": { "summarize.queued": 5, "classify.pending": 12, ... }, "total": 612 }

rhizome status --citekey smith2023ashwa --json
# {
#   "rhizome_id": "...",
#   "citekey": "...",
#   "pipeline_overall": "in_progress",
#   "pipeline_steps": {
#     "fulltext.marker": { "status": "complete" },
#     "fulltext.docling": { "status": "skipped", "skip_reason": "provider_disabled" },
#     "summarize": { "status": "complete" },
#     "classify": { "status": "pending" }
#   }
# }
```

## 7. Data Directory Layout

Rhizome stores its working data in `.siss/` inside the project directory:

```
.siss/
├── siss.db                    # SQLite database
├── config.yaml                # configuration
├── skills/                    # AI skill prompt files
│   ├── summarizer.md
│   ├── classifier.md
│   └── curator.md
├── .siss-env/                 # Python virtual environment (Marker)
└── logs/                      # optional log files
```

## 8. Implementation Steps

### Step 1 (Phase 1): Core CLI Scaffold
- Set up project with Bun, TypeScript, commander/citty
- Implement `rhizome init` (creates folders, writes config)
- Implement writer lock manager (`rhizome lock status|clear --force`)
- Implement `rhizome config show`/`set`/`validate`
- Implement `rhizome status` (reads from SQLite)
- Test: `rhizome init` creates a working setup

### Step 2 (Phase 1): Sync Commands
- Implement `rhizome sync zotero`
- Wire to Zotero client (spec 03)
- Test: sync pulls 2 studies from test collection

### Step 3 (Phase 2): Process Commands
- Implement `rhizome process` (non-AI stages)
- Implement `rhizome process --ai` (with window checking)
- Test: full pipeline for 2 studies

### Step 4 (Phase 3): Reprocess Commands
- Implement `rhizome reprocess` with filters
- Implement `rhizome retry`
- Test: reprocess a study, verify versioning

### Step 5 (Phase 4): Taxonomy Commands
- Implement `rhizome taxonomy` subcommands
- Implement review workflow
- Test: full taxonomy review cycle

### Step 6 (Phase 4): Polish
- Implement `--json` output for all commands
- Implement `--quiet` flag
- Implement `rhizome audit` commands
- Implement `rhizome list` with filters

### Testing Strategy
- CLI tests: invoke commands, check exit codes and output
- Integration tests: full workflows (init → sync → process → status)
- Config validation tests: valid and invalid configs
- JSON output tests: verify parseable JSON for all commands
