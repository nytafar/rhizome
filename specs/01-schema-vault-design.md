# 01 — Schema & Vault Design

**Version:** 0.2 | **Status:** Draft for review
**Depends on:** 00-architecture-overview
**Consumed by:** All other specs (this is the data contract)

---

## 1. Purpose

This spec defines the canonical data shapes, folder conventions, note templates, and Bases views that every other component implements against. Changes here ripple everywhere — this is the foundation.

**Data Authority Principle:** SQLite is the system of record for all machine state. Frontmatter is a read-only projection written by the vault writer stage. Manual frontmatter edits are not read back — all mutations go through the CLI.

## 2. Identity Model (Resolves F07)

Every study has two identifiers:

| Identifier | Mutability | Purpose |
|---|---|---|
| `siss_id` | **Immutable** | UUID, assigned on first ingest. Primary key in SQLite. Never changes. |
| `citekey` | **Mutable** (rare) | Derived from author+year+title. Used for filenames and human reference. |

If bibliographic metadata changes (e.g., author correction in Zotero), the citekey *could* change. When it does:
1. Files are renamed (note + asset directory)
2. An alias entry is added to `_system/citekey_aliases.json`
3. Old citekey resolves to new via alias lookup
4. Obsidian wikilinks break — user is notified to update (or a vault-wide rename is offered)

**For MVP:** Citekey is generated once and never changes. The alias system is designed-for but not built.

## 3. StudyRecord Interface

```typescript
interface StudyRecord {
  // === Identity ===
  siss_id: string;                    // UUID, immutable
  citekey: string;                    // derived, used for filenames

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
  volume?: string;
  issue?: string;
  pages?: string;
  url?: string;
  item_type?: string;               // journalArticle | book | preprint | etc.

  // === Zotero Sync ===
  zotero_key?: string;
  zotero_version?: number;
  zotero_sync_status?: "active" | "removed_upstream";  // manual review flow
  removed_upstream_at?: string;       // ISO date
  removed_upstream_reason?: string;

  // === Pipeline State (canonical model from spec 00) ===
  pipeline_overall: PipelineOverallStatus;
  pipeline_steps: Record<string, PipelineStepState>;
  pipeline_error?: string;            // most recent unresolved error
  last_pipeline_run?: string;       // ISO date

  // === Asset Paths (relative to vault root) ===
  asset_dir?: string;
  pdf_path?: string;
  fulltext_path?: string;
  summary_path?: string;

  // === PDF Metadata ===
  pdf_available: boolean;
  pdf_source?: string;              // zotero | europepmc | unpaywall | openalex | manual

  // === Fixed Classification (Tier 1) ===
  // Populated by classifier, see Section 5

  // === Evolving Classification (Tier 2) ===
  // Populated by classifier, managed by taxonomy system, see Section 6

  // === AI Provenance ===
  summary_skill_version?: string;
  classifier_skill_version?: string;
  summary_model?: string;
  classifier_model?: string;
  summary_generated_at?: string;
  classifier_generated_at?: string;
  taxonomy_provisional?: ProvisionalTaxonomyValue[];

  // === Source Tracking ===
  source: string;                   // zotero | bibtex | manual | api
  source_collections?: string[];
  source_tags?: string[];
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

interface ProvisionalTaxonomyValue {
  group: string;
  value: string;
  confidence: number;
  proposed_by: string;
  logged_at: string;                  // ISO date
}
```

## 4. Frontmatter Schema

The frontmatter is the serialized form of StudyRecord, written as YAML in the canonical study note. Every property here is validated by a zod schema.

### Tier 0: Identity + Pipeline
```yaml
siss_id: "550e8400-e29b-41d4-a716-446655440000"
citekey: "smith2023ashwagandha"
note_type: "study"
pipeline_overall: "in_progress"
pipeline_steps:
  ingest:
    status: "complete"
    updated_at: "2026-03-25T17:20:00Z"
    retries: 0
  zotero_sync:
    status: "complete"
    updated_at: "2026-03-25T17:20:05Z"
    retries: 0
  fulltext.marker:
    status: "complete"
    updated_at: "2026-03-25T17:21:10Z"
    retries: 0
  fulltext.docling:
    status: "skipped"
    updated_at: "2026-03-25T17:21:10Z"
    retries: 0
    skip_reason: "provider_disabled"
  summarize:
    status: "complete"
    updated_at: "2026-03-25T17:31:00Z"
    retries: 0
  classify:
    status: "pending"
    updated_at: "2026-03-25T17:31:01Z"
    retries: 0
pipeline_error: null
last_pipeline_run: "2026-03-25"
```

### Tier 1: Bibliographic
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
volume: "112"
issue: "4"
pages: "155-163"
item_type: "journalArticle"
```

### Tier 2: Zotero Sync
```yaml
zotero_key: "ABC123"
zotero_version: 42
zotero_sync_status: "active"
removed_upstream_at: null
removed_upstream_reason: null
source: "zotero"
source_collections:
  - "Adaptogens"
  - "Clinical Trials"
source_tags:
  - "ashwagandha"
  - "cortisol"
```

### Tier 3: Assets
```yaml
asset_dir: "Research/studies/_assets/smith2023ashwagandha/"
pdf_path: "Research/studies/_assets/smith2023ashwagandha/source.pdf"
pdf_available: true
pdf_source: "unpaywall"
fulltext_path: "Research/studies/_assets/smith2023ashwagandha/fulltext.md"
summary_path: "Research/studies/_assets/smith2023ashwagandha/summary.current.md"
```

### Tier 4: Fixed Classification (populated by classifier)
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

### Tier 5: Domain-Specific Classification (populated by classifier)
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

### Tier 6: Evolving Taxonomy (managed by taxonomy system)
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

### Tier 7: AI Provenance
```yaml
summary_skill_version: "1.0"
classifier_skill_version: "1.0"
summary_model: "claude-opus-4-5"
classifier_model: "claude-opus-4-5"
summary_generated_at: "2026-03-25T17:30:00Z"
classifier_generated_at: "2026-03-25T17:31:00Z"
taxonomy_provisional:
  - group: "mechanisms"
    value: "mitochondrial biogenesis"
    confidence: 0.72
    proposed_by: "classifier_v1.0"
    logged_at: "2026-03-25T17:31:00Z"
```

### Tier 8: User Space (never machine-written)
```yaml
user_tags: []
user_rating: 0
notes: ""
```

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
    │       │   └── classify.v1.json     # archived version
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
        ├── citekey_aliases.json        # (future) for citekey renames
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
  research_root: "Research"           # parent folder for everything
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
{full frontmatter as defined in Section 4}
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

## Assets
- [[{pdf_path}|PDF]]
- [[{fulltext_path}|Full Text]]
- [[{summary_path}|AI Summary]]
- [Open in Zotero](zotero://select/items/{zotero_key})

## Version History
| Date | Stage | Skill Version | Model |
|---|---|---|---|
| {date} | summary | {v} | {model} |
| {date} | classify | {v} | {model} |
```

### Summary Asset (`_assets/{citekey}/summary.current.md`)

```markdown
---
note_type: study_summary
study_ref: {citekey}
skill_version: "1.0"
model: "claude-opus-4-5"
generated_at: "2026-03-25T17:30:00Z"
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
  - pipeline_overall
  - zotero_sync_status
  - pdf_available
  - summary_path
  - fulltext_path
sort:
  - property: year
    order: desc
```

### `fulltexts.base` — Browse Full Texts
```yaml
source:
  type: folder
  folder: Research/studies/_assets
filters:
  - file.name contains "fulltext"
properties:
  - file.name
  - file.folder
  - file.size
sort:
  - property: file.mtime
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
    - pipeline_overall = "needs_attention"
    - pipeline_steps.classify.status = "pending"
    - pdf_available = false
    - zotero_sync_status = "removed_upstream"
    - taxonomy_provisional != null
properties:
  - title
  - pipeline_overall
  - zotero_sync_status
  - pipeline_error
  - pdf_available
```

**Note:** Bases syntax will be validated against actual Obsidian Bases capabilities during implementation. The above is conceptual — exact filter/property syntax may need adjustment.

## 9. Versioning Strategy

### Summaries
- Active: `_assets/{citekey}/summary.current.md`
- Archive: `_assets/{citekey}/summary.v{n}.md`
- On reprocess: current is copied to `summary.v{n}.md`, new output replaces `summary.current.md`
- Study note always links to `summary.current.md`

### Classifications
- Active: frontmatter on canonical study note + `_assets/{citekey}/classify.current.json`
- Archive: `_assets/{citekey}/classify.v{n}.json`
- JSON contains the full classifier output including confidence scores
- Frontmatter contains only the final accepted values (no confidence scores)

### Version Numbering
- Sequential integer per study per artifact type
- Tracked in SQLite `job_stage_log` table
- Version N means "the Nth time this stage ran for this study"

## 10. Linking Strategy

### Wikilinks
- Study note → assets: `[[Research/studies/_assets/{citekey}/source.pdf|PDF]]`
- Study note → summary: `[[Research/studies/_assets/{citekey}/summary.current|AI Summary]]`
- User note → study: `[[Research/studies/{citekey}]]`
- Embeds: `![[...summary.current#TL;DR]]` for section transclusion

### Frontmatter Path Properties
- `pdf_path`, `fulltext_path`, `summary_path` are relative to vault root
- These are the machine-readable links; wikilinks in note body are the human-readable links
- Both are kept in sync by the vault writer

### Backlinks
- Obsidian's native backlinks panel shows all notes linking to a study
- No automated reverse-link indexing in MVP (rely on native Obsidian)
- Future: periodic indexer that computes `related_note_count` etc.

## 11. Zod Validation Schema

Every frontmatter write is validated against a zod schema before writing to disk. Schema covers:
- Required fields per pipeline step (e.g., after `zotero_sync`, `zotero_key` must be present)
- Value constraints (year > 1900, `pipeline_overall` in enum, per-step status in enum, confidence in `0..1`, etc.)
- Type safety (arrays are arrays, numbers are numbers)

```typescript
const StudyFrontmatterSchema = z.object({
  siss_id: z.string().uuid(),
  citekey: z.string().min(1),
  note_type: z.literal("study"),
  pipeline_overall: z.nativeEnum(PipelineOverallStatus),
  pipeline_steps: z.record(PipelineStepStateSchema),
  // ... etc for all fields
});
```

This schema is the single source of truth and is shared between:
- Vault writer (validates before writing)
- CLI status display (parses and validates frontmatter)
- AI skills (classifier JSON schema mirrors this)

## 12. Implementation Steps

### Step 1 (Phase 1): Minimal Schema
- Define `StudyRecord` with identity + bibliographic + pipeline fields only
- Define `PipelineOverallStatus`, `PipelineStepStatus`, and `JobStatus` enums
- Create zod schema for frontmatter (Tiers 0-3 only)
- Implement note template generator (simple version without classification sections)
- Implement folder creator (`rhizome init` creates directory structure)

### Step 2 (Phase 2): Add Asset Paths
- Extend schema with asset paths
- Implement asset directory creation
- Update note template with asset links

### Step 3 (Phase 3-4): Full Classification Schema
- Extend schema with Tier 4-7 fields
- Extend note template with classification sections
- Implement Bases view generators

### Testing Strategy
- Fixtures: sample StudyRecord objects for each pipeline stage
- Snapshot tests: generated markdown compared against known-good output
- Zod validation tests: valid and invalid frontmatter examples
- Round-trip tests: write note → read note → compare with original StudyRecord
