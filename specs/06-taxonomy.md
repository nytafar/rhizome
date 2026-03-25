# 06 — Taxonomy System

**Version:** 0.2 | **Status:** Draft for review
**Depends on:** 00-architecture-overview, 01-schema-vault-design, 05-ai-skills
**Consumed by:** 05-ai-skills (taxonomy feeds classifier), 07-cli (taxonomy commands)

---

## 1. Purpose

This spec defines the self-improving taxonomy system: how classification values evolve, how the curator agent proposes changes, how humans review and approve, how provisional values are cleaned up, and how changes propagate across the vault.

## 2. taxonomy.json Schema

```json
{
  "schema_version": 2,
  "last_updated": "2026-03-25T17:00:00Z",
  "classifier_skill_version": "1.0",
  "groups": {
    "therapeutic_areas": {
      "description": "Primary therapeutic/health areas addressed by the study",
      "values": {
        "stress": {
          "count": 23,
          "aliases": ["chronic stress", "psychological stress"],
          "status": "confirmed",
          "added_at": "2026-01-10",
          "last_used": "2026-03-25",
          "added_by": "classifier_v1.0"
        },
        "anxiety": {
          "count": 18,
          "aliases": ["GAD", "anxiety disorders"],
          "status": "confirmed",
          "added_at": "2026-01-15",
          "last_used": "2026-03-24",
          "added_by": "classifier_v1.0"
        }
      }
    },
    "mechanisms": {
      "description": "Biological mechanisms of action",
      "values": { }
    },
    "indications": {
      "description": "Clinical or product indications",
      "values": { }
    },
    "contraindications": {
      "description": "Known contraindications",
      "values": { }
    },
    "drug_interactions": {
      "description": "Known drug interactions",
      "values": { }
    },
    "research_gaps": {
      "description": "Identified gaps in current research",
      "values": { }
    }
  },
  "pending_review": [
    {
      "id": "P001",
      "group": "therapeutic_areas",
      "value": "metabolic syndrome",
      "proposed_by": "classifier_v1.0",
      "study_ref": "patel2023berberine",
      "confidence": 0.85,
      "count": 2,
      "first_seen": "2026-03-20",
      "status": "pending"
    }
  ],
  "deprecated": [
    {
      "value": "thermoregulation",
      "group": "mechanisms",
      "deprecated_at": "2026-03-15",
      "reason": "count <= 1 after 90 days",
      "replacement": null
    }
  ]
}
```

### Group Configuration
Groups are configurable in `config.yaml`:
```yaml
taxonomy:
  groups:
    - name: therapeutic_areas
      description: "Primary therapeutic/health areas"
    - name: mechanisms
      description: "Biological mechanisms of action"
    - name: indications
      description: "Clinical or product indications"
    - name: contraindications
      description: "Known contraindications"
    - name: drug_interactions
      description: "Known drug interactions"
    - name: research_gaps
      description: "Identified gaps in research"
    # Users can add custom groups:
    - name: delivery_mechanism
      description: "Drug delivery methods"
```

## 3. Taxonomy Manager

```typescript
class TaxonomyManager {
  constructor(private taxonomyPath: string);

  // Read current taxonomy
  async load(): Promise<Taxonomy>;

  // Save taxonomy (atomic write with backup)
  async save(taxonomy: Taxonomy): Promise<void>;

  // Register a value usage (increment count, update last_used)
  async recordUsage(group: string, value: string, studyRef: string): Promise<void>;

  // Add a pending review item
  async addPending(item: PendingReviewItem): Promise<string>;  // returns ID

  // Promote pending to confirmed (when count >= threshold)
  async autoPromote(threshold: number): Promise<PromotedItem[]>;

  // Get taxonomy summary for classifier input
  async getClassifierContext(): Promise<string>;

  // Check if a value exists in a group (including aliases)
  resolveAlias(group: string, value: string): string | null;
}
```

### Atomic Writes
taxonomy.json is critical state. Writes must be atomic:
1. Write to `taxonomy.json.tmp`
2. Validate the written file (parse JSON, check schema)
3. Rename `taxonomy.json.tmp` → `taxonomy.json`
4. On failure: `taxonomy.json.tmp` is discarded, original intact

### Classifier Context Generation
For the classifier's input, generate a compact representation:
```
# Current Taxonomy Values

## therapeutic_areas (23 values)
stress (23), anxiety (18), cognitive_performance (12), sleep (9), ...

## mechanisms (15 values)
HPA-axis modulation (15), GABA-A agonism (8), NF-kB inhibition (7), ...
```

This keeps the classifier prompt compact while giving it full awareness of existing values.

## 4. Curator Agent (Phase 5)

### Purpose
A scheduled Claude Code invocation that analyzes the taxonomy for maintenance:
- Promote high-count pending values
- Detect alias candidates
- Propose merges for too-narrow values
- Propose splits for too-broad values
- Flag deprecated values

### Invocation
```bash
claude -p \
  --system-prompt-file ./skills/curator.md \
  --json-schema "${CURATOR_SCHEMA}" \
  --output-format json \
  --max-turns 5 \
  --bare \
  --tools "Read" \
  "Review and maintain the taxonomy" < taxonomy_context.md
```

### Curator Skill: `skills/curator.md`
```markdown
You are a taxonomy curator for a phytochemical research database.
Review the current taxonomy state and propose maintenance actions.

## Rules
- MERGE: Values that are clearly aliases or near-synonyms
- SPLIT: Values with count > {threshold} that cover distinct sub-concepts
- PROMOTE: Pending values with count >= {threshold} and no conflicts
- DEPRECATE: Values with count <= 1 that are older than {days} days
- RENAME: Values that should be renamed for clarity or standards alignment

## Output
Produce a structured JSON of proposed changes. Never auto-apply.
All structural changes require human approval.
```

### Curator JSON Schema
```json
{
  "type": "object",
  "properties": {
    "auto_promoted": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "group": { "type": "string" },
          "value": { "type": "string" },
          "count": { "type": "integer" }
        }
      }
    },
    "proposed_merges": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "group": { "type": "string" },
          "sources": { "type": "array", "items": { "type": "string" } },
          "target": { "type": "string" },
          "reason": { "type": "string" },
          "affected_studies": { "type": "integer" }
        }
      }
    },
    "proposed_splits": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "group": { "type": "string" },
          "source": { "type": "string" },
          "proposed_values": { "type": "array", "items": { "type": "string" } },
          "reason": { "type": "string" }
        }
      }
    },
    "proposed_renames": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "group": { "type": "string" },
          "from": { "type": "string" },
          "to": { "type": "string" },
          "reason": { "type": "string" }
        }
      }
    },
    "proposed_deprecations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "group": { "type": "string" },
          "value": { "type": "string" },
          "reason": { "type": "string" }
        }
      }
    }
  }
}
```

## 5. Human Review Flow

### taxonomy_review.md (generated by curator)
```markdown
---
review_id: 42
date: 2026-03-25
status: pending
auto_promoted: 3
pending_human: 5
---

# Taxonomy Review #42

## Auto-Promoted (count >= 3, no conflicts)
- `gut_microbiome` → confirmed in therapeutic_areas (4 studies)
- `neuroinflammation` → confirmed in mechanisms (3 studies)
- `bioavailability` → confirmed in mechanisms (3 studies)

---

## Proposed Merges

### M1: `cortisol regulation` → alias of `HPA-axis modulation`
**Group:** mechanisms | **Affects:** 3 studies
**Reason:** identical mechanistic meaning, MeSH aligns with HPA-axis
- [ ] approve
- [ ] reject
- [ ] rename both to: ___

### M2: `chronic stress` + `psychological stress` → `stress`
**Group:** therapeutic_areas | **Affects:** 7 studies
**Reason:** too granular at current library size
- [ ] approve
- [ ] reject
- [ ] keep separate
- [ ] new name: ___

---

## Proposed Splits

### S1: `cognitive performance` → split (12 studies, 4 clusters)
**Group:** therapeutic_areas
**Proposed:** memory, executive function, neurogenesis, attention
- [ ] split as proposed
- [ ] custom split: ___
- [ ] keep as-is

---

## Flagged for Deprecation

### D1: `thermoregulation` (1 study, 120 days old)
- [ ] deprecate
- [ ] keep
- [ ] merge into: ___
```

### Approval Modes

#### Mode 1: CLI
```bash
rhizome taxonomy review                    # show pending
rhizome taxonomy approve --id M1           # approve merge
rhizome taxonomy approve --id S1 --values "memory,executive function,neurogenesis,attention"
rhizome taxonomy reject --id M2 --note "prefer granular at this stage"
rhizome taxonomy approve --all-auto        # approve all auto-promoted
```

#### Mode 2: Edit review document
Fill checkboxes in `taxonomy_review.md`, save. Rhizome detects changes on next `rhizome taxonomy apply`.

#### Mode 3: Conversational (Claude Code)
Tell Claude Code agent what to approve. Agent invokes CLI commands.

### Override Support
Any approval can include overrides:
```bash
rhizome taxonomy approve --id M2 --override-target "stress response"
rhizome taxonomy suggest --group delivery_mechanism --values "liposomal,nanoparticle,standard"
```

### Provisional Value Cleanup
Classifier-proposed `new:` values may already exist in study frontmatter as provisional values.
Maintenance flow:
1. Read `pending_review` in `taxonomy.json`
2. Read each study's `taxonomy_provisional` list
3. On approval: keep canonical value and remove matching provisional log entries
4. On rejection/merge: rewrite affected study values, then remove provisional log entries
5. Log every cleanup action to audit trail (`taxonomy_provisional_cleanup`)

## 6. Propagation (Resolves F08)

When a rename/merge/split is approved, propagation runs:

### Transaction Safety
```typescript
async function propagateRename(
  group: string,
  from: string,
  to: string,
  db: Database
): Promise<PropagationResult> {
  const studies = await findStudiesWithValue(group, from);
  const checkpoint = await createCheckpoint(db); // includes journal_id + target studies

  try {
    // Phase 1: Prepare journal + file backups (filesystem, outside DB transaction)
    await writePropagationPlan(checkpoint, { group, from, to, studies });
    await backupFrontmatterFiles(studies, checkpoint.journalId);

    // Phase 2: Apply per batch (idempotent)
    for (const batch of chunk(studies, 50)) {
      // 2a) Update files first (idempotent rewrite based on current content)
      for (const study of batch) {
        await updateStudyFrontmatter(study, group, from, to);
      }

      // 2b) Then update DB atomically for the same batch
      await db.transaction(async () => {
        for (const study of batch) {
          await updateStudyRecord(study, group, from, to);
        }
      });

      // 2c) Checkpoint after successful file+DB apply
      await updateCheckpoint(checkpoint, batch);
    }

    // Phase 3: finalize taxonomy state
    await taxonomyManager.renameValue(group, from, to);
    await markPropagationComplete(checkpoint);

    // Log
    await auditLog.append({
      action: "taxonomy_rename",
      group, from, to,
      affected: studies.length,
    });

    return { success: true, affected: studies.length };
  } catch (error) {
    // Recovery: do not assume DB rollback can revert filesystem changes.
    // Resume/reconcile from journal checkpoint on retry.
    await markPropagationFailed(checkpoint, String(error));
    throw error;
  }
}
```

### Resumable Checkpoints
- Checkpoint table in SQLite tracks propagation progress + journal id
- On interruption: `rhizome taxonomy apply --resume` picks up from last checkpoint
- Each batch is idempotent and recoverable; startup reconciliation repairs any file/DB drift before resuming

## 7. Configuration

```yaml
taxonomy:
  path: "_system/taxonomy.json"
  auto_promote_threshold: 3
  deprecation_days: 90
  max_pending_before_review: 20    # trigger curator when pending > N
  groups:
    - name: therapeutic_areas
      description: "Primary therapeutic/health areas"
    - name: mechanisms
      description: "Biological mechanisms of action"
    # ... etc
  curator:
    enabled: false                  # Phase 5
    schedule: "0 3 * * 0"          # weekly Sunday 3am
    skill_file: "curator.md"
```

## 8. Implementation Steps

### Step 1 (Phase 4): Taxonomy Manager
- Implement taxonomy.json read/write with atomic saves
- Implement value lookup and alias resolution
- Implement usage counting
- Implement pending review item management
- Test: add values, check counts, resolve aliases

### Step 2 (Phase 4): Classifier Integration
- Wire classifier output processing to taxonomy manager
- Implement `new:` prefix handling
- Implement auto-promote on count threshold
- Test: classify a study, verify taxonomy updated

### Step 3 (Phase 4): Review Flow
- Implement `taxonomy_review.md` generation
- Implement CLI approval commands
- Implement basic propagation (rename across vault)
- Implement provisional cleanup (remove resolved entries from `taxonomy_provisional`)
- Test: propose a merge, approve it, verify all studies updated

### Step 4 (Phase 5): Curator Agent
- Write `skills/curator.md` prompt
- Implement curator invocation and output parsing
- Implement scheduled execution
- Test: run curator on taxonomy with known patterns

### Step 5 (Phase 5): Advanced Propagation
- Implement split propagation
- Implement checkpoint/resume
- Implement bulk operations
- Test: large-scale rename with simulated interruption

### Testing Strategy
- taxonomy.json fixtures with known state
- Propagation tests with a small vault (5 study notes)
- Alias resolution tests
- Auto-promote threshold tests
- Checkpoint/resume tests (simulate interruption)
