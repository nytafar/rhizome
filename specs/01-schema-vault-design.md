# 01 — Schema & Vault Design

**Version:** 0.3 | **Status:** Active (contract migration from v0.2)
**Depends on:** 00-architecture-overview
**Consumed by:** All other specs (this is the data contract)
**Migration:** M005 implements the v0.2 → v0.3 contract migration

---

## 1. Purpose

This spec defines the canonical data shapes, folder conventions, note templates, and Bases views that every other component implements against. Changes here ripple everywhere — this is the foundation.

**Data Authority Principle:** SQLite is the system of record for all machine state. Frontmatter is a read-only projection written by the vault writer stage. Manual frontmatter edits are not read back — all mutations go through the CLI. User-managed fields (`user_*`, `tags`, `notes`) are never overwritten by the service.

## 2. Identity Model

Every study has two identifiers:

| Identifier | Mutability | Purpose |
|---|---|---|
| `rhizome_id` | **Immutable** | UUID, assigned on first ingest. Primary key in SQLite. Never changes. |
| `citekey` | **Mutable** (rare) | Derived from author+year+title. Used for filenames only — not stored in frontmatter. |

**Canonical identifier hierarchy** (for dedup and external lookups):
1. DOI (global, publisher-assigned)
2. PMID (biomedical global)
3. `rhizome_id` (service-generated UUID, always present)

Citekey is generated once on ingest using BBT-like logic and used as the filename stem. The alias system for citekey renames is designed-for but not built in MVP.

> **v0.2 → v0.3 migration note:** `siss_id` renamed to `rhizome_id`. `citekey` removed from frontmatter (remains in SQLite for filename derivation and `--citekey` CLI lookups). `rhizome_id` only appears in frontmatter when no DOI or PMID is available.

## 3. StudyRecord Interface (Internal)

This is the **runtime type** used inside the service. It is *not* the frontmatter shape — frontmatter is a projection (see Section 4).

```typescript
interface StudyRecord {
  // === Identity ===
  rhizome_id: string;                 // UUID, immutable, PK in SQLite
  citekey: string;                    // derived, used for filenames only

  // === Bibliographic (Zotero-authoritative) ===
  title: string;
  authors: Author[];
  year: number;
  journal?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  abstract?: string;
  url?: string;
  item_type?: string;                // journalArticle | book | preprint | etc.

  // === Zotero Identity (frontmatter-projected) ===
  zotero_key?: string;
  source_collections?: string[];

  // === Zotero Operational (SQLite-only, not in frontmatter) ===
  zotero_version?: number;
  zotero_sync_status?: "active" | "removed_upstream";
  removed_upstream_at?: string | null;
  removed_upstream_reason?: string | null;

  // === Pipeline State (SQLite canonical, not in frontmatter) ===
  pipeline_overall: PipelineOverallStatus;
  pipeline_steps: Record<string, PipelineStepState>;
  pipeline_error?: string | null;
  last_pipeline_run?: string;

  // === Pipeline Surface (frontmatter-projected) ===
  has_pdf: boolean;
  has_fulltext: boolean;
  has_summary: boolean;
  has_classification: boolean;
  pipeline_status: "complete" | "partial" | "failed" | "pending";

  // === Asset Paths (internal, used for wikilink generation) ===
  asset_dir?: string;
  pdf_path?: string;
  fulltext_path?: string;
  summary_path?: string;

  // === PDF Metadata ===
  pdf_available: boolean;
  pdf_source?: "zotero" | "europepmc" | "unpaywall" | "openalex" | "manual";

  // === AI Provenance ===
  summary_skill?: string;             // "default-summarizer@1.2"
  classifier_skill?: string;          // "nutraceutical-classifier@2.0"
  summary_generated_at?: string;
  classifier_generated_at?: string;
  summary_versions?: string[];        // wikilink array

  // === Tags (single Obsidian-native field) ===
  tags?: string[];

  // === Source Tracking ===
  source: string;                     // zotero | bibtex | manual | api
  date_added?: string;
}

interface Author {
  family: string;
  given: string;
}

interface PipelineStepState {
  status: PipelineStepStatus;
  updated_at: string;
  retries: number;
  error?: string;
  skip_reason?: string;
  duration_ms?: number;
}
```

## 4. Frontmatter Schema (Obsidian Projection)

The frontmatter is a **subset** of StudyRecord, written as YAML. Every property is validated by a Zod schema before disk write. User-managed fields are preserved on re-sync (merge, not overwrite).

### Identity
```yaml
rhizome_id: "550e8400-e29b-41d4-a716-446655440000"  # only if no DOI/PMID
note_type: "study"
```

### Pipeline Surface
```yaml
has_pdf: true
has_fulltext: true
has_summary: true
has_classification: true
pipeline_status: "complete"    # complete | partial | failed | pending
pipeline_error: null
last_pipeline_run: "2026-03-25"
```

### Bibliographic
```yaml
title: "Ashwagandha root extract reduces cortisol in chronically stressed adults"
authors:
  - family: Smith
    given: J
  - family: Patel
    given: R
year: 2023
journal: "Phytomedicine"
doi: "10.1016/j.phymed.2023.01.012"
pmid: "37291847"
item_type: "journalArticle"
```

> **Removed from frontmatter (v0.3):** `volume`, `issue`, `pages`. These are low-query fields available via `zotero_key` link. They remain in `StudyRecord` internally and in the Zotero field mapper.

### Zotero
```yaml
zotero_key: "ABC123"
source_collections:
  - "Adaptogens"
  - "Clinical Trials"
```

> **Moved to SQLite (v0.3):** `zotero_version`, `zotero_sync_status`, `source`, `removed_upstream_at`, `removed_upstream_reason`. Sync algorithm reads these from SQLite, not frontmatter.

### Tags
```yaml
tags:
  - ashwagandha
  - cortisol
  - RCT
  - my-personal-tag
```

Single Obsidian-native `tags` field. Zotero-sourced tags are written on **initial ingest only** (no re-sync tag updates). User-added tags are preserved forever. Complex diff-based re-sync is deferred.

> **Removed from frontmatter (v0.3):** `source_tags`, `user_tags`. Merged into single `tags`.

### Assets (wikilinks)
```yaml
pdf: "[[Research/studies/_assets/smith2023ashwagandha/source.pdf|PDF]]"
fulltext: "[[Research/studies/_assets/smith2023ashwagandha/fulltext|Full Text]]"
summary: "[[Research/studies/_assets/smith2023ashwagandha/summary.current|Summary]]"
user_note: null
pdf_available: true
pdf_source: "unpaywall"
```

Machine path extraction from wikilinks: `/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/` → group 1 is the path.

> **Removed from frontmatter (v0.3):** `pdf_path`, `fulltext_path`, `summary_path`, `asset_dir` as separate fields. Replaced by wikilink properties that render as clickable links in Obsidian.

### Fixed Classification (Tier 4 — populated by classifier)
```yaml
study_type: "RCT"
sample_size: 120
duration_weeks: 8
population: "adults with chronic stress, 25-60 years"
control: "placebo"
blinding: "double-blind"
primary_outcome: "serum cortisol reduction"
outcome_direction: "positive"
effect_size: "moderate"
significance: "p<0.001"
evidence_quality: "high"
funding_source: "independent"
conflict_of_interest: false
```

### Domain-Specific Classification (Tier 5 — populated by classifier)
```yaml
herb_species:
  - "Withania somnifera"
common_name:
  - "ashwagandha"
active_compounds:
  - "withanolides"
  - "withaferin A"
plant_part:
  - "root"
extraction_type:
  - "ethanolic"
extraction_spec: "5% withanolides"
dosage: "600mg/day"
adverse_events:
  - "mild GI discomfort"
safety_rating: "good"
```

### Evolving Taxonomy (Tier 6 — managed by taxonomy system)
```yaml
therapeutic_areas:
  - "stress"
  - "anxiety"
mechanisms:
  - "HPA-axis modulation"
  - "cortisol suppression"
indications:
  - "adaptogen"
  - "anxiolytic"
```

### AI Provenance
```yaml
summary_skill: "default-summarizer@1.2"
classifier_skill: "nutraceutical-classifier@2.0"
summary_generated_at: "2026-03-25T17:30:00Z"
classifier_generated_at: "2026-03-25T17:31:00Z"
summary_versions:
  - "[[Research/studies/_assets/smith2023ashwagandha/summary.v1|v1 — default-summarizer@1.0 — 2026-01-10]]"
  - "[[Research/studies/_assets/smith2023ashwagandha/summary.v2|v2 — default-summarizer@1.1 — 2026-02-15]]"
```

> **Changed (v0.3):** `summary_skill_version` + `summary_model` merged into `summary_skill: "name@version"`. Model stored in SQLite `pipeline_runs` only. `taxonomy_provisional` moved to `_assets/{citekey}/taxonomy_provisional.json`.

### User Space (never machine-written)
```yaml
user_rating: null           # 1-5 or null
user_priority: null         # high | medium | low | null
user_status: null           # reading | read | flagged | null
notes: ""
```

The service **never overwrites** these fields. On re-sync, existing values are read from the current note and preserved in the merge.

## 5. Citekey Generation

### Format
`{firstauthorlastname}{year}{firstmeaningfultitleword}`

### Rules
1. Author: first author's family name, lowercase, ASCII-normalized (ü→u, é→e, ø→o)
2. Year: 4-digit publication year
3. Title word: first word of title that isn't a stopword (the, a, an, of, in, on, for, and, with, is, are, was, were, from, by, to, at, as), lowercase
4. All concatenated, no separators: `smith2023ashwagandha`
5. Collision handling: append `b`, `c`, `d`, etc.: `smith2023ashwagandha`, `smith2023ashwagandrab`
6. Max length: 60 characters (truncate title word if needed)

### Examples
| Title | Authors | Year | Citekey |
|---|---|---|---|
| "Ashwagandha root extract reduces cortisol" | Smith J, Patel R | 2023 | `smith2023ashwagandha` |
| "A randomized trial of curcumin in depression" | Jones K | 2024 | `jones2024randomized` |
| "Effects of berberine on glucose metabolism" | Müller H | 2022 | `muller2022effects` |

## 6. Folder Structure

```
{vault_root}/
└── Research/                           # configurable in config.yaml
    ├── studies/                         # canonical study notes (one per study)
    │   ├── smith2023ashwagandha.md
    │   ├── jones2024curcumin.md
    │   └── _assets/                    # machine-generated artifacts per study
    │       ├── smith2023ashwagandha/
    │       │   ├── source.pdf
    │       │   ├── fulltext.md          # parsed markdown (Marker output)
    │       │   ├── summary.current.md   # latest summary
    │       │   ├── summary.v1.md        # archived version
    │       │   ├── classify.current.json # latest classification output
    │       │   ├── classify.v1.json     # archived version
    │       │   ├── taxonomy_provisional.json  # provisional taxonomy (v0.3)
    │       │   └── pipeline.snapshot.json     # point-in-time pipeline export (v0.3)
    │       └── jones2024curcumin/
    │           └── ...
    │
    ├── study-notes/                    # user-authored notes about studies (optional)
    │   └── smith2023ashwagandha.note.md
    │
    ├── _imports/                       # drop zone for bulk imports
    │   ├── bibtex/
    │   │   └── done/
    │   ├── researchrabbit/
    │   │   └── done/
    │   └── litmaps/
    │       └── done/
    │
    └── _system/                        # Rhizome-managed metadata and views
        ├── taxonomy.json
        ├── taxonomy_review.md
        ├── taxonomy_log.md
        ├── studies.base                # main study database view
        ├── fulltexts.base              # browse extracted full texts
        ├── review-queue.base           # incomplete pipeline, flagged items
        └── audit_log.md                # human-readable audit trail (optional)
```

### Folder Configuration
All folder names are configurable in `config.yaml`:
```yaml
vault:
  path: "/path/to/vault"
  research_root: "Research"
  studies_folder: "studies"
  assets_folder: "_assets"
  study_notes_folder: "study-notes"
  imports_folder: "_imports"
  system_folder: "_system"
```

## 7. Note Templates

### Canonical Study Note (`studies/{citekey}.md`)

```markdown
---
{frontmatter as defined in Section 4}
---

# {title}

> [!abstract]
> {abstract}

## Snapshot
| | |
|---|---|
| **Type** | {study_type} |
| **Population** | {population} |
| **Duration** | {duration_weeks} weeks |
| **Sample** | n={sample_size} |
| **Outcome** | {outcome_direction} ({effect_size}) |
| **Evidence** | {evidence_quality} |

## TL;DR
![[{asset_dir}summary.current#TL;DR]]

## Key Findings
![[{asset_dir}summary.current#Key Findings]]

## Compounds & Dosing
| Compound | Part | Extraction | Dose |
|---|---|---|---|
| {compound} | {plant_part} | {extraction_type} | {dosage} |

## Links
- [Open in Zotero](zotero://select/items/{zotero_key})

## Version History
| Date | Stage | Skill |
|---|---|---|
| {date} | summary | {summary_skill} |
| {date} | classify | {classifier_skill} |
```

> **Changed (v0.3):** Assets section removed from note body — asset links are now wikilink properties in frontmatter (clickable in Obsidian). Version history simplified to `skill` column (model is in SQLite). "Links" section retained for non-wikilink references.

### Summary Asset (`_assets/{citekey}/summary.current.md`)

```markdown
---
note_type: study_summary
study_citekey: {citekey}
skill: "default-summarizer@1.2"
generated_at: "2026-03-25T17:30:00Z"
source: "fulltext"
---

## TL;DR
{2-3 sentence summary}

## Background & Rationale
{why this study was conducted}

## Methods
{study design, population, interventions, measurements}

## Key Findings
{structured findings with data points}

## Clinical / Practical Relevance
{what this means for practitioners, product developers}

## Limitations
{methodological limitations, generalizability concerns}

## Compounds & Doses
{if applicable: what was used, how much, what form}

## Open Questions
{what remains unanswered, suggested follow-up research}
```

## 8. Bases Views

### `studies.base` — Main Study Database
```yaml
source:
  type: folder
  folder: Research/studies
filters:
  - note_type = "study"
properties:
  - title
  - year
  - study_type
  - herb_species
  - therapeutic_areas
  - outcome_direction
  - evidence_quality
  - pipeline_status
  - has_summary
  - has_pdf
  - pdf
  - summary
  - tags
sort:
  - property: year
    order: desc
```

### `review-queue.base` — Items Needing Attention
```yaml
source:
  type: folder
  folder: Research/studies
filters:
  - note_type = "study"
  - or:
    - pipeline_status = "failed"
    - pipeline_status = "partial"
    - has_summary = false
    - has_pdf = false
properties:
  - title
  - pipeline_status
  - pipeline_error
  - has_pdf
  - has_summary
  - has_classification
```

> **Changed (v0.3):** Bases use `pipeline_status` and `has_*` booleans instead of nested `pipeline_steps` and `zotero_sync_status`.

## 9. Versioning Strategy

### Summaries
- Active: `_assets/{citekey}/summary.current.md`
- Archive: `_assets/{citekey}/summary.v{n}.md`
- On reprocess: current is copied to `summary.v{n}.md`, new output replaces `summary.current.md`
- Study note frontmatter `summary_versions` array tracks history as wikilinks
- Study note always links to `summary.current` via `summary` wikilink property

### Classifications
- Active: frontmatter on canonical study note + `_assets/{citekey}/classify.current.json`
- Archive: `_assets/{citekey}/classify.v{n}.json`
- Frontmatter contains only accepted values (no confidence scores)

### Provisional Taxonomy
- Written to: `_assets/{citekey}/taxonomy_provisional.json`
- Read by: `TaxonomyCurator` for review/promote workflows
- Not in frontmatter (v0.3)

### Pipeline Snapshot
- Written once on pipeline completion: `_assets/{citekey}/pipeline.snapshot.json`
- Point-in-time export of final pipeline run for portability/export
- Not a live document — service reads from SQLite, not this file

### Version Numbering
- Sequential integer per study per artifact type
- Tracked in SQLite `pipeline_runs` table
- Version N means "the Nth time this stage ran for this study"

## 10. Linking Strategy

### Wikilink Properties (frontmatter)
- `pdf`: `[[Research/studies/_assets/{citekey}/source.pdf|PDF]]`
- `fulltext`: `[[Research/studies/_assets/{citekey}/fulltext|Full Text]]`
- `summary`: `[[Research/studies/_assets/{citekey}/summary.current|Summary]]`
- `user_note`: `[[Research/study-notes/{citekey}.note|Notes]]` (or null)

These render as clickable links in Obsidian and are the canonical asset reference.

### Machine Path Extraction
When service code needs the raw path from a wikilink property:
```typescript
function extractWikilinkPath(wikilink: string): string | null {
  const match = wikilink.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
  return match?.[1] ?? null;
}
```

### Embeds
- `![[...summary.current#TL;DR]]` for section transclusion in study note body

### Backlinks
- Obsidian's native backlinks panel shows all notes linking to a study
- No automated reverse-link indexing in MVP

## 11. Zod Validation Schema

Every frontmatter write is validated against a Zod schema before writing to disk.

```typescript
const StudyFrontmatterSchema = z.object({
  // Identity
  rhizome_id: z.string().uuid().optional(),  // only if no DOI/PMID
  note_type: z.literal("study"),

  // Pipeline surface
  has_pdf: z.boolean(),
  has_fulltext: z.boolean(),
  has_summary: z.boolean(),
  has_classification: z.boolean(),
  pipeline_status: z.enum(["complete", "partial", "failed", "pending"]),
  pipeline_error: z.string().nullable(),
  last_pipeline_run: z.string().optional(),  // ISO date

  // Bibliographic
  title: z.string().min(1),
  authors: z.array(AuthorSchema).min(1),
  year: z.number().int().gt(1900),
  journal: z.string().optional(),
  doi: z.string().optional(),
  pmid: z.string().optional(),
  item_type: z.string().optional(),

  // Zotero
  zotero_key: z.string().optional(),
  source_collections: z.array(z.string()).optional(),

  // Tags
  tags: z.array(z.string()).optional(),

  // Assets (wikilinks)
  pdf: z.string().optional(),
  fulltext: z.string().optional(),
  summary: z.string().optional(),
  user_note: z.string().nullable().optional(),
  pdf_available: z.boolean(),
  pdf_source: z.enum(["zotero", "europepmc", "unpaywall", "openalex", "manual"]).optional(),

  // Classification fields (Tiers 4-6) — added by classifier, omitted here for brevity

  // AI Provenance
  summary_skill: z.string().optional(),
  classifier_skill: z.string().optional(),
  summary_generated_at: z.string().optional(),
  classifier_generated_at: z.string().optional(),
  summary_versions: z.array(z.string()).optional(),

  // User fields (never overwritten by service)
  user_rating: z.number().int().min(1).max(5).nullable().optional(),
  user_priority: z.enum(["high", "medium", "low"]).nullable().optional(),
  user_status: z.enum(["reading", "read", "flagged"]).nullable().optional(),
  notes: z.string().optional(),
});
```

Schema enforces:
- Value constraints (year > 1900, pipeline_status in enum, etc.)
- Type safety (arrays are arrays, numbers are numbers)
- User fields use `.optional()` + `.nullable()` — service emits defaults on first write, preserves existing values on re-sync

## 12. SQLite Schema (v0.3 additions)

### `studies` table changes
```sql
-- v0.3: rename siss_id → rhizome_id, add Zotero ops columns, add tombstone
ALTER TABLE studies RENAME COLUMN siss_id TO rhizome_id;
ALTER TABLE studies ADD COLUMN zotero_version INTEGER;
ALTER TABLE studies ADD COLUMN zotero_sync_status TEXT DEFAULT 'active';
ALTER TABLE studies ADD COLUMN zotero_tags_snapshot TEXT;  -- JSON, for future merge logic
ALTER TABLE studies ADD COLUMN tombstone BOOLEAN DEFAULT false;
ALTER TABLE studies ADD COLUMN tombstone_reason TEXT;
ALTER TABLE studies ADD COLUMN tombstone_at TEXT;
```

### New `pipeline_runs` table
```sql
CREATE TABLE IF NOT EXISTS pipeline_runs (
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

### Foreign key updates
All `REFERENCES studies(siss_id)` become `REFERENCES studies(rhizome_id)` in `jobs` and `job_stage_log` tables.

## 13. Vault Writer Merge Strategy

The vault writer follows a **merge-on-write** pattern:

1. **First write** (no existing file): Generate full frontmatter with service defaults for user fields (`null`/empty)
2. **Re-sync** (file exists): Read existing frontmatter, preserve user-managed keys (`tags`, `user_*`, `notes`, `user_note`), overwrite machine-managed keys
3. **Corrupted frontmatter**: If existing file can't be parsed, write fresh and log warning

User-managed fields:
- `tags` — written once on ingest, never overwritten
- `user_rating`, `user_priority`, `user_status`, `notes`, `user_note` — never written by service

Machine-managed fields: everything else. These are overwritten from `StudyRecord` state on every vault write.

## 14. Implementation Steps

### Step 1 (M005): Contract Migration
- Rename `siss_id` → `rhizome_id` across codebase
- Split `StudyRecord` (internal) from `StudyFrontmatter` (projection)
- SQLite migration v2 (column renames, new tables, Zotero ops columns)
- Rewrite note-builder frontmatter projection
- Implement merge-on-write vault writer
- Update all test fixtures and snapshots

### Step 2 (M002): PDF + Fulltext
- Asset wikilink properties populated by PDF fetch / marker stages

### Step 3 (M003): Production AI + Versioning
- `summary_versions` rotation logic
- `pipeline.snapshot.json` export
- Reprocessing with `--skill-lt`

### Step 4 (M004): Classification + Taxonomy
- Tier 4-6 fields populated by classifier
- `taxonomy_provisional.json` written by classifier
- Full Zod schema with classification fields

### Testing Strategy
- Fixtures: sample StudyRecord objects for each pipeline stage
- Snapshot tests: generated markdown compared against known-good output
- Zod validation tests: valid and invalid frontmatter for v0.3 shape
- Merge tests: existing file with user edits survives re-sync
