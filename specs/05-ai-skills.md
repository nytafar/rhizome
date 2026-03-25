# 05 — AI Skills (Claude Code Integration)

**Version:** 0.2 | **Status:** Draft for review
**Depends on:** 00-architecture-overview, 01-schema-vault-design, 02-pipeline-queue, 04-pdf-parsing
**Consumed by:** 06-taxonomy (classifier output feeds taxonomy system)

---

## 1. Purpose

This spec defines how Rhizome invokes Claude Code for AI-powered summarization and classification. It covers the invocation contract, skill file design, input/output schemas, error handling, and versioning.

## 2. Invocation Contract (Resolves F02)

### The Pattern
Rhizome prepares an input file, invokes Claude Code CLI in print mode with a JSON schema, and parses the validated output.

```bash
claude -p \
  --system-prompt-file "${RHIZOME_DIR}/skills/${SKILL_NAME}.md" \
  --json-schema "${JSON_SCHEMA_STRING}" \
  --output-format json \
  --max-turns ${MAX_TURNS} \
  --bare \
  --tools "Read" \
  "${PROMPT_TEXT}" < "${INPUT_FILE}"
```

### Key Flags
| Flag | Purpose |
|---|---|
| `-p` (print) | Non-interactive mode, exits after completion |
| `--system-prompt-file` | Loads the skill prompt from a file |
| `--json-schema` | Validates output against our schema — Claude returns conforming JSON |
| `--output-format json` | Machine-parseable output |
| `--max-turns` | Prevents runaway sessions (10 for summarizer, 5 for classifier) |
| `--bare` | Skips auto-discovery for fast startup (~2s vs ~5s) |
| `--tools "Read"` | Restricts Claude to read-only (no file writes, no bash) |

### Input Truncation
Fulltext input is truncated to `ai.max_input_tokens` (default 80,000 tokens, ~50 pages). If truncated:
- A marker is appended: `[DOCUMENT TRUNCATED: showing first {N} of {total} estimated tokens]`
- Output carries `source: "fulltext_truncated"`
- Evidence quality capped at "moderate" for truncated inputs

### Input Preparation
For each study, Rhizome generates a temporary input file combining:
```markdown
# Study Metadata
Title: {title}
Authors: {authors}
Year: {year}
Journal: {journal}
DOI: {doi}
PMID: {pmid}
Study Type: {item_type}

# Abstract
{abstract}

# Full Text (two_pass strategy only)
{fulltext_markdown — only included when ai.strategy = "two_pass"}

# Summary + Structured Extraction (piped strategy, default)
{AI-generated summary including structured extraction section}
```

This is piped to Claude Code via stdin.

### Output Parsing
```typescript
interface ClaudeCodeResult {
  exitCode: number;
  stdout: string;        // JSON when --output-format json
  stderr: string;
  durationMs: number;
}

async function invokeClaudeCode(
  skill: string,
  input: string,
  jsonSchema: object,
  config: AIConfig
): Promise<ClaudeCodeResult> {
  const schemaStr = JSON.stringify(jsonSchema);

  const proc = Bun.spawn([
    "claude", "-p",
    "--system-prompt-file", `${config.skills_dir}/${skill}.md`,
    "--json-schema", schemaStr,
    "--output-format", "json",
    "--max-turns", String(config.max_turns),
    "--bare",
    "--tools", "Read",
    "Process this study according to your instructions.",
  ], {
    stdin: Buffer.from(input),
    timeout: config.timeout_ms,
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { exitCode, stdout, stderr, durationMs: /* measured */ };
}
```

### Failure Handling
| Exit Code | Meaning | Action |
|---|---|---|
| 0 | Success | Parse JSON from stdout |
| Non-zero | Claude Code error | Check stderr, log error, retry or fail |
| Timeout | Exceeded timeout_ms | Kill process, mark error, retryable |

On ANY failure:
1. Save raw stdout/stderr to `_assets/{citekey}/debug/{skill}_{timestamp}.txt`
2. Mark job as error
3. If parse failure (exit 0 but invalid JSON): save raw output, flag as parse_error
4. All failures are retryable (up to max_retries)

## 2b. AI Processing Strategies

Rhizome supports three strategies, configured via `ai.strategy`:

### `piped` (MVP default)
Pass 1: Summarizer reads fulltext → produces summary with **Structured Extraction** section.
Pass 2: Classifier reads summary output only (~2K tokens) + taxonomy context → returns classification JSON.

### `two_pass` (future)
Pass 1: Summarizer reads fulltext → produces summary.
Pass 2: Classifier reads fulltext independently + taxonomy context → returns classification JSON.

### `single_pass` (future)
Pass 1: Combined skill reads fulltext → produces both summary and classification in one JSON output, split into separate files post-hoc.

Only `piped` is implemented in MVP. The strategy is a config switch — the pipeline orchestrator selects which skill files and inputs to use based on `ai.strategy`.

## 3. Summarizer Skill

### Skill File: `skills/summarizer.md`
```markdown
You are a research study summarizer specializing in phytochemical and
nutraceutical research. Your audience is a researcher focused on
practical, clinical, and product development insights.

You will receive a study's metadata and full text (or abstract if full
text is unavailable). Produce a structured summary following the exact
JSON schema provided.

## Guidelines
- Be precise and quantitative. Include specific numbers, p-values,
  effect sizes, dosages, and durations.
- For the TL;DR: 2-3 sentences that a busy researcher can scan in
  10 seconds to decide if this study matters.
- For clinical relevance: focus on what a practitioner or product
  developer would care about. Dosing, formulation, population
  applicability.
- For limitations: be honest. Flag small sample sizes, short durations,
  industry funding, or methodological weaknesses.
- If full text is not available and you're working from abstract only,
  note this in limitations and be conservative with claims.
- Compounds & Doses section: extract every compound mentioned with
  its specific dose, frequency, and duration if available.
- IMPORTANT (piped mode): Include a "Structured Extraction" section at
  the end of your summary that surfaces ALL classifiable data in a
  consistent format: species (binomial), common names, compounds,
  dosages, plant parts, extraction types, adverse events, study design
  details. This section is used by the downstream classifier.
```

### Summarizer JSON Schema
```json
{
  "type": "object",
  "required": ["source", "tldr", "background", "methods", "key_findings", "clinical_relevance", "limitations"],
  "additionalProperties": false,
  "properties": {
    "source": {
      "type": "string",
      "enum": ["fulltext", "abstract_only"],
      "description": "What evidence source was used for this output"
    },
    "tldr": {
      "type": "string",
      "description": "2-3 sentence summary for quick scanning"
    },
    "background": {
      "type": "string",
      "description": "Why this study was conducted, what gap it addresses"
    },
    "methods": {
      "type": "string",
      "description": "Study design, population, interventions, measurements"
    },
    "key_findings": {
      "type": "string",
      "description": "Structured findings with specific data points"
    },
    "clinical_relevance": {
      "type": "string",
      "description": "Practical implications for clinicians and product developers"
    },
    "limitations": {
      "type": "string",
      "description": "Methodological limitations and generalizability concerns"
    },
    "compounds_and_doses": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "compound": { "type": "string" },
          "dose": { "type": "string" },
          "frequency": { "type": "string" },
          "duration": { "type": "string" }
        }
      }
    },
    "open_questions": {
      "type": "string",
      "description": "What remains unanswered, suggested follow-up"
    },
    "structured_extraction": {
      "type": "object",
      "description": "Machine-readable extraction of classifiable fields for downstream classifier (piped mode)",
      "properties": {
        "herb_species": { "type": "array", "items": { "type": "string" } },
        "common_names": { "type": "array", "items": { "type": "string" } },
        "active_compounds": { "type": "array", "items": { "type": "string" } },
        "plant_parts": { "type": "array", "items": { "type": "string" } },
        "extraction_types": { "type": "array", "items": { "type": "string" } },
        "dosages": { "type": "array", "items": { "type": "string" } },
        "adverse_events": { "type": "array", "items": { "type": "string" } },
        "study_type": { "type": ["string", "null"] },
        "sample_size": { "type": ["integer", "null"] },
        "duration": { "type": ["string", "null"] },
        "population": { "type": ["string", "null"] }
      }
    }
  }
}
```

### Summary → Markdown Conversion
The JSON output is converted to the markdown summary file:
```typescript
function summaryJsonToMarkdown(json: SummarizerOutput, meta: SkillMeta): string {
  return `---
note_type: study_summary
study_ref: ${meta.citekey}
skill_version: "${meta.skillVersion}"
model: "${meta.model}"
generated_at: "${meta.generatedAt}"
source: "${json.source}"
---

## TL;DR
${json.tldr}

## Background & Rationale
${json.background}

## Methods
${json.methods}

## Key Findings
${json.key_findings}

## Clinical / Practical Relevance
${json.clinical_relevance}

## Limitations
${json.limitations}

## Compounds & Doses
${json.compounds_and_doses?.map(c =>
  `- **${c.compound}**: ${c.dose} ${c.frequency || ''} for ${c.duration || 'unspecified'}`
).join('\n') || 'Not applicable'}

## Open Questions
${json.open_questions || 'None identified'}
`;
}
```

## 4. Classifier Skill

### Skill File: `skills/classifier.md`
```markdown
You are a research study classifier for a phytochemical and
nutraceutical research database. Your job is to extract structured
metadata from a study for database indexing.

You will receive:
1. The study's metadata and full text (or abstract)
2. The current taxonomy with existing values and their usage counts

## Classification Rules
- For FIXED fields (study_type, sample_size, etc.): extract directly
  from the study text. Use null if not determinable.
- For TAXONOMY fields (therapeutic_areas, mechanisms, etc.): strongly
  prefer existing taxonomy values. Only propose new values when the
  study clearly covers a concept not represented.
- New taxonomy values: prefix with "new:" (e.g., "new:mitochondrial_biogenesis")
- `new:` values are allowed in canonical frontmatter immediately, but MUST
  also be logged as provisional for maintenance cleanup.
- If an existing value seems like an alias of what you'd naturally
  write, use the existing value and note the alias.
- Assign a confidence score (0.0-1.0) for each classification.
- For herb/compound classification: use binomial nomenclature for
  species (e.g., "Withania somnifera" not "ashwagandha"), but include
  common names separately.
```

### Classifier Input
```markdown
# Study Metadata
{same as summarizer}

# Full Text (two_pass strategy only)
{fulltext_markdown — only included when ai.strategy = "two_pass"}

# Summary + Structured Extraction (piped strategy, default)
{AI-generated summary including structured extraction section}

# Current Taxonomy
{JSON dump of taxonomy.json groups with counts}
```

### Classifier JSON Schema
```json
{
  "type": "object",
  "required": ["source", "fixed", "taxonomy"],
  "additionalProperties": false,
  "properties": {
    "source": {
      "type": "string",
      "enum": ["fulltext", "abstract_only"]
    },
    "fixed": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "study_type": { "type": ["string", "null"] },
        "sample_size": { "type": ["integer", "null"] },
        "duration_weeks": { "type": ["number", "null"] },
        "population": { "type": ["string", "null"] },
        "control": { "type": ["string", "null"] },
        "blinding": { "type": ["string", "null"] },
        "primary_outcome": { "type": ["string", "null"] },
        "outcome_direction": {
          "type": ["string", "null"],
          "enum": ["positive", "negative", "neutral", "mixed", null]
        },
        "effect_size": { "type": ["string", "null"] },
        "significance": { "type": ["string", "null"] },
        "evidence_quality": {
          "type": ["string", "null"],
          "enum": ["high", "moderate", "low", null]
        },
        "funding_source": { "type": ["string", "null"] },
        "conflict_of_interest": { "type": ["boolean", "null"] }
      }
    },
    "domain": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "herb_species": { "type": "array", "items": { "type": "string" } },
        "common_name": { "type": "array", "items": { "type": "string" } },
        "active_compounds": { "type": "array", "items": { "type": "string" } },
        "plant_part": { "type": "array", "items": { "type": "string" } },
        "extraction_type": { "type": "array", "items": { "type": "string" } },
        "extraction_spec": { "type": ["string", "null"] },
        "dosage": { "type": ["string", "null"] },
        "adverse_events": { "type": "array", "items": { "type": "string" } },
        "safety_rating": {
          "type": ["string", "null"],
          "enum": ["good", "caution", "contraindicated", null]
        }
      }
    },
    "taxonomy": {
      "type": "object",
      "additionalProperties": false,
      "description": "Evolving taxonomy classifications. Use existing values or prefix new ones with 'new:'",
      "properties": {
        "therapeutic_areas": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["value", "confidence"],
            "additionalProperties": false,
            "properties": {
              "value": { "type": "string" },
              "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
            }
          }
        },
        "mechanisms": { "$ref": "#/properties/taxonomy/properties/therapeutic_areas" },
        "indications": { "$ref": "#/properties/taxonomy/properties/therapeutic_areas" },
        "contraindications": { "$ref": "#/properties/taxonomy/properties/therapeutic_areas" },
        "drug_interactions": { "$ref": "#/properties/taxonomy/properties/therapeutic_areas" },
        "research_gaps": { "$ref": "#/properties/taxonomy/properties/therapeutic_areas" }
      }
    }
  }
}
```

### Classifier Output Processing
```typescript
type TaxonomyGroup =
  | "therapeutic_areas"
  | "mechanisms"
  | "indications"
  | "contraindications"
  | "drug_interactions"
  | "research_gaps";

function processClassifierOutput(output: ClassifierOutput, study: StudyRecord): {
  frontmatterUpdates: Partial<StudyRecord>;
  taxonomyPending: PendingReviewItem[];
} {
  const updates: Partial<StudyRecord> = {};
  const pending: PendingReviewItem[] = [];
  const provisional: ProvisionalTaxonomyValue[] = [];
  const taxonomyUpdates: Partial<Record<TaxonomyGroup, string[]>> = {};

  // Fixed classifications → directly to frontmatter
  Object.assign(updates, output.fixed);
  Object.assign(updates, output.domain);

  // Taxonomy classifications → check for new: prefix
  for (const [group, items] of Object.entries(output.taxonomy) as [TaxonomyGroup, { value: string; confidence: number }[]][]) {
    const accepted: string[] = [];
    for (const item of items) {
      if (item.value.startsWith("new:")) {
        const cleanValue = item.value.replace("new:", "");
        pending.push({
          group,
          value: cleanValue,
          proposed_by: `classifier_v${study.classifier_skill_version}`,
          study_ref: study.citekey,
          confidence: item.confidence,
        });
        provisional.push({
          group,
          value: cleanValue,
          confidence: item.confidence,
          proposed_by: `classifier_v${study.classifier_skill_version}`,
          logged_at: new Date().toISOString(),
        });
        accepted.push(cleanValue); // allowed in frontmatter, but marked provisional
      } else {
        accepted.push(item.value);
      }
    }
    taxonomyUpdates[group] = accepted;
  }

  Object.assign(updates, taxonomyUpdates);
  updates.taxonomy_provisional = provisional;

  return { frontmatterUpdates: updates, taxonomyPending: pending };
}
```

## 5. Skill Versioning

### Version Tracking
Each skill file has a version comment at the top:
```markdown
<!-- skill_version: 1.0 -->
# Summarizer Skill
...
```

The version is:
- Read by Rhizome before invocation
- Written to the output file's frontmatter (`skill_version: "1.0"`)
- Written to the study note's frontmatter (`summary_skill_version: "1.0"`)
- Stored in `job_stage_log` metadata

### Reprocessing by Version
```bash
# Find studies summarized with skill version < 1.3
rhizome reprocess --stage summary --skill-version-lt 1.3

# Semver-aware filtering (not lexical string compare):
# 1) query candidates
SELECT s.citekey, s.summary_skill_version FROM studies s
WHERE s.pipeline_overall = 'complete'
# 2) in application code:
# semverLt(s.summary_skill_version, "1.3.0")
```

## 6. Summary Versioning

When a summary is reprocessed:
1. Read current `summary.current.md`
2. Determine next version number from existing `summary.v{n}.md` files
3. Copy current to `summary.v{n}.md`
4. Write new output to `summary.current.md`
5. Update study frontmatter (`summary_skill_version`, `summary_generated_at`)
6. Log version change in `job_stage_log`

Same pattern for classification: `classify.current.json` → `classify.v{n}.json`.

## 7. Fallback: Abstract-Only Processing

When a study has no PDF (or parsing fails):
- Input to summarizer contains abstract only + "Full text not available" note
- Summarizer produces a shorter, more conservative summary
- Classifier works from abstract + summary
- Both outputs carry a flag: `source: "abstract_only"`
- Evidence quality is automatically capped at "low" for abstract-only classification

## 8. Configuration

```yaml
ai:
  windows:
    - "04:00-06:00"
    - "17:00-19:00"
    - "23:00-01:00"
  timezone: "Europe/Oslo"
  batch_size: 20
  cooldown_seconds: 30
  skills_dir: ".siss/skills/"    # canonical location (see spec 07 §4)
  strategy: "piped"              # piped | two_pass | single_pass
  max_input_tokens: 80000        # per-study fulltext truncation limit
  summarizer:
    skill_file: "summarizer.md"
    skill_version: "1.0"
    max_turns: 10
    timeout_ms: 300000
  classifier:
    skill_file: "classifier.md"
    skill_version: "1.0"
    max_turns: 5
    timeout_ms: 180000
  claude_binary: "claude"        # path to claude CLI
```

## 9. Implementation Steps

### Step 0 (Phase 2): Prototype Invocation
**CRITICAL: Do this first, before any other AI work.**
- Write a minimal test script that:
  1. Prepares a sample study input file
  2. Invokes `claude -p --json-schema ... --bare` with a trivial schema
  3. Parses the JSON output
  4. Measures time and reliability
- Run it 5 times. Note: exit codes, output format, timing, failures.
- This validates the entire invocation contract.

### Step 1 (Phase 3): Summarizer
- Write `skills/summarizer.md` prompt
- Define summarizer JSON schema
- Implement `invokeClaudeCode` function
- Implement `summaryJsonToMarkdown` converter
- Implement summary file writing to `_assets/`
- Wire into pipeline as `summarize` stage
- Test: run summarizer on 2 test studies

### Step 2 (Phase 3): Summary Versioning
- Implement version detection (list existing `summary.v{n}.md`)
- Implement archive-and-replace flow
- Test: reprocess a summary, verify versioning

### Step 3 (Phase 4): Classifier
- Write `skills/classifier.md` prompt
- Define classifier JSON schema
- Implement classifier output processing (new: prefix handling)
- Implement frontmatter merge
- Wire into pipeline as `classify` stage
- Test: run classifier on 2 test studies, verify frontmatter

### Step 4 (Phase 4): Taxonomy Integration
- Implement pending_review item creation
- Persist provisional taxonomy log on study frontmatter (`taxonomy_provisional`)
- Implement taxonomy count updates
- Wire classifier output to taxonomy system (spec 06)

### Testing Strategy
- **Prototype test (Step 0)**: real Claude Code invocation, small input
- **Unit tests**: JSON schema validation, markdown conversion, version detection
- **Integration tests**: full invocation with 2 real studies using Claude Code Pro
- **Snapshot tests**: compare generated summary/classification against expected structure
- **Schema contract tests**: verify JSON schemas match zod schemas from spec 01
