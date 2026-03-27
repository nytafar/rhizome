# 00 — Architecture Overview

**Version:** 0.4 | **Status:** Draft for review
**Depends on:** Nothing (root document)
**Consumed by:** All other specs

---

## 1. What Rhizome Is

Rhizome is a CLI-driven research pipeline that synchronizes academic studies between Zotero and an Obsidian vault, enriching each study with AI-generated summaries and structured classifications.

It is **not** a web service, not an always-on daemon (in MVP), and not an MCP server. It is a command-line tool that you (or an agent) invoke when you want work done.

## 2. Revised Core Principles

1. **Zotero is metadata master.** Bibliographic truth lives in Zotero.
2. **Vault is intelligence master.** Summaries, classifications, user notes, and knowledge links live in Obsidian.
3. **All vault operations are file-based.** Obsidian never needs to be running.
4. **`rhizome_id` is the immutable primary key.** Citekeys are derived, mutable aliases. (Resolves F07)
5. **Pipeline stages are independently rerunnable.** Any stage can fail, retry, or be selectively rerun without affecting others.
6. **AI processing is time-windowed.** Claude Code invocations respect configurable usage windows.
7. **Everything is auditable.** Every state transition is logged in SQLite with optional markdown export.
8. **Design for expansion, build for now.** Plan interfaces for future providers, but only implement Zotero for MVP.
9. **Strict single-writer mutation.** Exactly one mutating process can run at a time (lockfile enforced).
10. **SQLite is the system of record.** All machine state (pipeline, classifications, sync metadata) lives in SQLite. Frontmatter is a read-only projection written by the vault writer. Manual frontmatter edits are not read back — all mutations go through the CLI.

## 3. System Boundaries

```
┌──────────────────────────────────────────────────────────┐
│                  External Sources                         │
│  Zotero Web API  │  (future: BibTeX, OpenAlex, RR, LM)  │
└────────────────────────┬─────────────────────────────────┘
                         │ normalize to StudyRecord
                         ▼
┌──────────────────────────────────────────────────────────┐
│                     Rhizome Core                             │
│                                                           │
│  CLI ──→ Pipeline Orchestrator ──→ SQLite Job Queue       │
│                                                           │
│  Stages (each independently rerunnable):                  │
│   1. Ingest      (source → StudyRecord)                   │
│   2. Zotero sync (StudyRecord ↔ Zotero item) [optional]  │
│   3. PDF fetch   (tiered waterfall)                       │
│   4. Parse       (PDF → markdown via parser provider)      │
│   5. Summarize   (Claude Code → summary markdown)         │
│   6. Classify    (Claude Code → taxonomy YAML)            │
│   7. Vault write (StudyRecord → canonical .md note)       │
│   8. Bases sync  (.base files regenerated)                │
└────────────────────────┬─────────────────────────────────┘
                         │
           ┌─────────────┴──────────────┐
           ▼                            ▼
┌──────────────────┐        ┌───────────────────────┐
│  Zotero Cloud    │        │  Obsidian Vault        │
│  (metadata)      │        │  (intelligence)        │
└──────────────────┘        └───────────────────────┘
```

## 4. Technology Stack

| Concern | Choice | Justification |
|---|---|---|
| Runtime | Bun (only) | Native TS, built-in SQLite, fast CLI startup. No Node fallback in this project. (Resolves F03) |
| Language | TypeScript (strict) | Type safety for complex data shapes (StudyRecord, taxonomy, pipeline state) |
| Job queue | `bun:sqlite` | Persistent, lightweight, sufficient for single-node. Interface-abstracted for future swap. |
| Config validation | `zod` | Runtime type safety + schema versioning (Resolves F10) |
| PDF parsing (MVP) | Marker (`marker-pdf`) | Clean markdown output, fast, lighter than Docling. Python 3.10+ sidecar, pinned version, managed via `uv`. (Resolves F04) |
| PDF parsing (future) | Provider interface | Abstracted behind `MarkdownProvider` interface. GROBID (citations), Docling (tables) available as future add-ons. |
| AI execution | Claude Code CLI | `--json-schema` for validated structured output, `--bare` for fast startup, `--tools` for sandboxing. (Resolves F02) |
| YAML frontmatter | `gray-matter` | Battle-tested frontmatter parser |
| CLI framework | `commander` or `citty` | TBD based on Bun compatibility testing |

### Runtime Policy (Resolves F03)
- Bun is the only runtime for MVP and production
- No Node fallback path is maintained
- CI runs against Bun only (latest + pinned project version)
- Any dependency that requires Node-only behavior is considered out of scope

### PDF Parser Provider Interface
Rhizome abstracts PDF-to-markdown conversion behind a `MarkdownProvider` interface. This is an architectural boundary — the pipeline never calls a parser directly, only through the provider contract. MVP has one active provider; the interface exists to prevent parser lock-in.

```typescript
interface MarkdownProvider {
  id: string;                     // "marker" | "docling" | "grobid"
  parse(pdfPath: string, outputDir: string, options?: ParseOptions): Promise<ParseResult>;
  healthcheck(): Promise<boolean>;
}

interface ParseResult {
  markdownPath: string;           // path to generated .md
  metadata: {
    pageCount: number;
    parserVersion: string;
    parsedAt: string;             // ISO date
  };
}
```

Multi-provider orchestration (e.g., Marker first, Docling fallback for tables) is **disabled in MVP, designed-in for later.**

### Python Sidecar (Resolves F04)
- Marker requires Python 3.10+ and PyTorch
- Managed via `uv` (fast Python package manager)
- Pinned version in `pyproject.toml`
- `rhizomeinit` bootstraps the Python env and runs `marker_single --help` healthcheck
- Marker is invoked as a subprocess, not imported
- No Python in the main Bun codepath — strictly a sidecar process

## 5. AI Execution Contract (Resolves F02)

Claude Code CLI is invoked in **print mode** with structured output:

```bash
claude -p \
  --system-prompt-file "${SKILL_PATH}" \
  --json-schema "${SCHEMA}" \
  --output-format json \
  --max-turns ${MAX_TURNS} \
  --bare \
  --tools "Read" \
  "${PROMPT}" < "${INPUT_FILE}"
```

Key constraints:
- `--bare`: skips auto-discovery (hooks, skills, plugins, MCP) for fast startup
- `--json-schema`: validates output against our defined schema — parse failures are caught
- `--tools "Read"`: Claude can only read files, not write/edit (we handle file writes)
- `--max-turns`: prevents runaway sessions (default 10 for summarizer, 5 for classifier)
- Raw output preserved on parse failure for debugging
- Timeout: configurable per skill (default 300s)

On failure:
- Usage exhausted → job returns to `ai_queued`, retried next window
- Parse failure → job marked `error`, raw output saved to `_assets/{citekey}/debug/`
- Timeout → job marked `error`, retryable

### Token Budget
Each study's fulltext input is truncated to `ai.max_input_tokens` (default 80,000, ~50 pages). If truncated, a marker is appended and the output carries `source: "fulltext_truncated"`. Window-level cost control is achieved through `batch_size` — no per-window token accounting in MVP.

### Error Classification
Failures are classified as **transient** or **permanent**:

| Class | Meaning | Examples | Handling |
|---|---|---|---|
| Transient | Likely to succeed on retry | Timeout, rate limit, usage exhausted, network error | Retry up to `max_retries` (default 3 for non-AI, 1 for AI stages) |
| Permanent | Will not succeed without intervention | Corrupted PDF, invalid Zotero item, persistent parse failure, schema violation | Mark `paused` immediately, log reason, notify on next `rhizomestatus` |

AI stages default to `max_retries: 1` (retry once in next window, then pause). Non-AI stages default to `max_retries: 3`.

## 5b. AI Processing Strategy

Rhizome supports three AI processing strategies, selectable via `ai.strategy` in config. All three produce the same outputs (summary.current.md + classify.current.json) but differ in cost, accuracy, and token usage.

| Strategy | Summarizer Input | Classifier Input | AI Calls | Relative Cost | Accuracy |
|---|---|---|---|---|---|
| `piped` (default) | Fulltext | Summary output only | 2 | Low | Good |
| `two_pass` | Fulltext | Fulltext | 2 | High | Best |
| `single_pass` | Fulltext | N/A (combined) | 1 | Lowest | Unknown |

### `piped` (MVP default)
The summarizer reads fulltext and produces a human summary with a **Structured Extraction** section that surfaces all classifiable data (species, dosages, mechanisms, etc.). The classifier then reads only the condensed summary (~2K tokens) instead of fulltext (~50-100K tokens), returning harmonized metadata as JSON for frontmatter.

### `two_pass`
Both summarizer and classifier independently read the full text. Most accurate extraction but doubles token cost. Useful for high-value studies or when piped mode misses domain details.

### `single_pass`
A single combined skill produces both summary and classification in one JSON schema. Cheapest but riskiest — complex prompts may degrade both outputs. Designed for benchmarking against piped mode.

All three strategies are designed-in from the start but only `piped` is implemented in MVP. The others are available for A/B testing when the pipeline is stable.

## 6. Configuration Versioning (Resolves F10)

```yaml
config_version: 1
# ... rest of config
```

- `config_version` is mandatory
- `rhizomeinit` creates config at current version
- On startup, Rhizome checks version and runs migrations if needed
- Migrations are sequential: v1→v2→v3
- Pre-migration backup created automatically
- `rhizomeconfig migrate` runs manually if needed

## 7. MVP Scope

### Phase 1: Prove the Intelligence Loop (Zotero → Vault + AI)
- Schema definition (minimal fields)
- Zotero sync (one direction: Zotero → vault)
- Note creation in vault with frontmatter
- Abstract-only summarizer path (for fast validation of AI executor)
- CLI: `rhizome init`, `rhizome sync zotero`, `rhizome process --ai`, `rhizome status`
- **Test:** 2 studies from a Zotero collection appear as structured notes and each has `summary.current.md`

### Phase 2: Add PDF + Parsing
- PDF fetch waterfall (Zotero attachment → Unpaywall → EuropePMC)
- Marker integration (single parser provider)
- Asset directory structure
- CLI: `rhizomeprocess` (non-AI stages)
- **Test:** Studies have PDFs and extracted full-text markdown

### Phase 3: Scale Intelligence
- Summarizer skill (Claude Code invocation)
- Job queue with AI windows
- Summary versioning
- CLI: `rhizomeprocess --ai`, `rhizomereprocess`
- **Test:** Studies have AI summaries, respecting time windows

### Phase 4: Add Classification
- Classifier skill
- Taxonomy system (taxonomy.json, pending review)
- Full frontmatter schema (Tier 1 + Tier 2 classifications)
- Bases views
- CLI: `rhizometaxonomy` commands
- **Test:** Studies are classified, taxonomy evolves with new studies

### Phase 5: Polish & Expand
- Curator agent (scheduled)
- Vault → Zotero reverse sync
- Import providers (BibTeX, etc.)
- Advanced Bases views
- Bulk operations

## 8. Granular Pipeline Reporting Model (Resolves F01)

Rhizome tracks pipeline state at two levels:
- `pipeline_overall`: coarse health/progress for dashboards and quick filtering
- `pipeline_steps`: granular per-step status (including provider-specific full-text steps)

```typescript
enum PipelineOverallStatus {
  NOT_STARTED = "not_started",
  IN_PROGRESS = "in_progress",
  COMPLETE = "complete",
  NEEDS_ATTENTION = "needs_attention",
}

enum PipelineStep {
  INGEST = "ingest",
  ZOTERO_SYNC = "zotero_sync",
  PDF_FETCH = "pdf_fetch",
  FULLTEXT_MARKER = "fulltext.marker",
  FULLTEXT_DOCLING = "fulltext.docling",  // usually skipped in MVP
  SUMMARIZE = "summarize",
  CLASSIFY = "classify",
  VAULT_WRITE = "vault_write",
  BASES_SYNC = "bases_sync",
}

enum PipelineStepStatus {
  PENDING = "pending",
  QUEUED = "queued",
  PROCESSING = "processing",
  COMPLETE = "complete",
  SKIPPED = "skipped",
  FAILED = "failed",
  BLOCKED = "blocked",
}

interface PipelineStepState {
  status: PipelineStepStatus;
  updated_at: string;               // ISO date
  retries: number;
  error?: string;
  skip_reason?: string;
  duration_ms?: number;
}
```

Reporting behavior:
- CLI/Bases use `pipeline_overall` for quick status and `pipeline_steps` for drill-down.
- Stages can be independently `complete`, `skipped`, or `blocked`; no assumption that every prior stage completed.
- Example: `fulltext.marker=complete`, `fulltext.docling=skipped`, `summarize=complete`, `classify=pending`.

### Single-Writer Enforcement
- All mutating commands acquire a global lock before executing (`.siss/locks/mutator.lock`).
- Read-only commands (`rhizomestatus`, `rhizomelist`, `rhizomeaudit`) do not require the lock.
- If lock exists and is healthy, mutating commands fail fast with a clear message and exit code.
- Lock metadata includes: `pid`, `host`, `command`, `acquired_at`, `heartbeat_at`.
- Stale locks (default 15 minutes without heartbeat) can be cleared with `rhizomelock clear --force`.

## 9. Implementation Steps (Local macOS Dev)

### Step 0: Environment Setup
```bash
# Bun
curl -fsSL https://bun.sh/install | bash

# Python + Marker
curl -LsSf https://astral.sh/uv/install.sh | sh
uv venv .siss-env --python 3.11
uv pip install marker-pdf

# Project scaffold
mkdir siss && cd siss
bun init
```

### Step 1: Schema + Types (spec 01)
- Define `StudyRecord` interface in TypeScript
- Define `PipelineOverallStatus`, `PipelineStep`, `PipelineStepStatus` enums
- Define frontmatter schema as zod schema
- Write note template generator

### Step 2: SQLite + Queue (spec 02)
- Create database schema (jobs, job_stage_log, zotero_sync_state)
- Implement queue operations (enqueue, dequeue, update, query)
- Implement AI window checker

### Step 3: Zotero Client (spec 03)
- Implement Zotero Web API client (pull items, delta sync)
- Implement field mapper (Zotero item → StudyRecord)
- Implement sync state persistence

### Step 4: Vault Writer (spec 01)
- Implement note builder (StudyRecord → markdown)
- Implement frontmatter writer
- Implement folder structure creation
- Implement Bases file generator

### Step 5: PDF + Parsing Pipeline (spec 04)
- Implement PDF fetch waterfall
- Implement Marker subprocess invocation via MarkdownProvider interface
- Wire into pipeline stages

### Step 6: AI Skills (spec 05)
- Write summarizer skill prompt
- Write summarizer JSON schema
- Implement Claude Code subprocess invocation
- Implement output parsing and validation
- Implement summary versioning

### Step 7: Classifier + Taxonomy (specs 05, 06)
- Write classifier skill prompt
- Implement taxonomy.json manager
- Implement classification → frontmatter merge
- Implement pending_review flow

### Step 8: CLI (spec 07)
- Wire up all commands
- Implement `rhizomeinit` setup flow
- Implement config schema + validation

## 10. Future Parser Expansion (Not MVP)

The `MarkdownProvider` interface enables two planned additions without pipeline changes:

### Future Step A: GROBID Citation Enrichment
- **Purpose:** Structured inline citation and reference linkage. Maps `[1]` markers to full bibliographic records, enabling citation graph construction.
- **Trigger:** Optional post-parse stage (`CITATION_ENRICHED`), not in MVP pipeline.
- **Output:** Citation graph JSON + mapped references appended to study metadata.
- **Integration:** New pipeline stage inserted between fulltext steps and `summarize`. Stage is skippable — studies process without it by default.

### Future Step B: Docling Table Recovery
- **Purpose:** Improved table fidelity for papers with complex tables that Marker handles poorly.
- **Trigger:** Fallback/heuristic (e.g., study flagged with `tables_need_review: true` by summarizer) or manual rerun.
- **Output:** Table patches merged into canonical markdown in `_assets/`.
- **Integration:** Runs as a selective reprocess, not in the default pipeline path.

### Reserved Future Pipeline Stages
These stages exist in the design but are **not active in MVP**:
```typescript
// Future — not in active step registry until implemented
// CITATION_ENRICHED = "citation_enriched"   // Step A: GROBID
// TABLES_ENRICHED = "tables_enriched"       // Step B: Docling
```

## 11. Cross-Spec Concerns

| Concern | How Addressed |
|---|---|
| F01: Pipeline state consistency | Two-layer model: `pipeline_overall` + granular `pipeline_steps` (Section 8) |
| F02: Claude invocation contract | `--json-schema` + `--bare` + `--tools` (Section 5) |
| F03: Bun runtime policy | Bun-only runtime, no Node fallback (Section 4) |
| F04: Python sidecar (Marker) | `uv` managed, pinned version, healthcheck. Provider interface for future parsers. (Section 4) |
| F05: Zotero sync state | Explicit schema in spec 02 + spec 03 |
| F06: Timezone/DST | Addressed in spec 02 (AI windows) |
| F07: Citekey mutability | `rhizome_id` is immutable PK, citekey is derived alias (Section 2) |
| F08: Taxonomy propagation safety | Transaction-backed batches in spec 06 |
| F09: Sci-Hub compliance | Removed from MVP, plugin/extension later |
| F10: Config versioning | `config_version` + migrator (Section 6) |
