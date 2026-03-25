# Rhizome Specification Index

**Project:** Rhizome (Research Intelligence Pipeline)
**Version:** 0.4 | **Date:** 2026-03-25
**Authors:** Lasse + Claude Opus (architecture), Perplexity (alpha PRD), GPT-5.4 (vault structure reasoning)

---

## Specs

| # | Spec | Status | Purpose |
|---|---|---|---|
| 00 | [Architecture Overview](00-architecture-overview.md) | Draft | System boundaries, principles, tech stack, AI strategies, MVP phases |
| 01 | [Schema & Vault Design](01-schema-vault-design.md) | Draft | Data contract, frontmatter schema, folder structure, Bases |
| 02 | [Pipeline & Queue](02-pipeline-queue.md) | Draft | Job queue, state machine, AI windows, error taxonomy |
| 03 | [Zotero Sync](03-zotero-sync.md) | Draft | Zotero Web API integration, delta sync, field mapping |
| 04 | [PDF Parsing](04-pdf-parsing.md) | Draft | PDF acquisition waterfall, Marker provider, parser abstraction |
| 05 | [AI Skills](05-ai-skills.md) | Draft | Claude Code invocation, piped strategy, summarizer, classifier |
| 06 | [Taxonomy](06-taxonomy.md) | Draft | Self-improving classification system, curator, review flow |
| 07 | [CLI & Config](07-cli-config.md) | Draft | CLI commands, configuration schema, setup flow |

## Dependency Graph

```
00-architecture-overview ─────────────────────────────
 │
 ├─ 01-schema-vault-design ◄── FOUNDATIONAL
 │    (StudyRecord, frontmatter, folders, Bases)
 │
 ├─ 02-pipeline-queue ◄── ORCHESTRATION
 │    (pipeline_overall + pipeline_steps, job queue, AI windows)
 │   │
 │   ├─ 03-zotero-sync
 │   │    (implements ingest + zotero_sync steps)
 │   │
 │   ├─ 04-pdf-parsing
 │   │    (implements pdf_fetch + fulltext.marker steps)
 │   │
 │   └─ 05-ai-skills
 │        (implements summarize + classify steps)
 │       │
 │       └─ 06-taxonomy
 │            (consumes classifier output, feeds next classification)
 │
 └─ 07-cli-config
      (user interface to all of the above)
```

## Review Findings Addressed

| Finding | Severity | Resolution | Spec |
|---|---|---|---|
| F01: Pipeline state inconsistency | Blocker | Granular step statuses + derived overall state | 00 §8 |
| F02: Claude invocation contract | Blocker | `--json-schema` + `--bare` + `--tools` pattern | 00 §5, 05 §2 |
| F03: Runtime policy | High | Bun-only runtime policy (no Node fallback) | 00 §4 |
| F04: Parser Python sidecar | High | `uv` managed, pinned Marker, healthcheck, provider interface | 00 §4, 04 §3-4 |
| F05: Zotero sync state schema | High | Explicit `zotero_sync_state` table | 02 §3, 03 §4 |
| F06: Timezone/DST for AI windows | High | Explicit timezone config + cross-midnight rules | 02 §5 |
| F07: Citekey mutability risk | Medium | `siss_id` as immutable PK, citekey as alias | 01 §2 |
| F08: Taxonomy propagation safety | Medium | Journaled two-phase apply + checkpoints | 06 §6 |
| F09: Sci-Hub compliance | Medium | Removed from MVP core, future plugin | 04 §2 |
| F10: Config versioning | Medium | `config_version` + migration system | 00 §6, 07 §4 |

## Build Phases

### Phase 1: Prove the Intelligence Loop
- **Specs:** 01 (minimal), 02 (basic queue), 03 (read-only), 05 (abstract-only summarizer), 07 (init + sync + status + process --ai)
- **Goal:** Zotero → vault with usable AI summaries from abstract/fulltext fallback
- **Test:** 2 studies from test collection appear as .md files and each has `summary.current.md`

### Phase 2: Add PDF + Parsing
- **Specs:** 01 (add asset paths), 02 (add stages), 04 (full), 07 (process command)
- **Goal:** Studies have PDFs and extracted full text
- **Test:** PDFs fetched, Marker parses to markdown, assets in correct locations

### Phase 3: Scale Intelligence
- **Specs:** 02 (AI windows), 05 (piped strategy + versioning), 07 (process --ai, reprocess)
- **Goal:** AI summaries at scale with time-windowed processing and per-study token budget
- **Test:** Summaries generated during configured windows, versioning and retry behavior work

### Phase 4: Add Classification
- **Specs:** 01 (full schema), 05 (classifier in piped mode), 06 (taxonomy), 07 (taxonomy commands)
- **Goal:** Studies classified via piped strategy, taxonomy evolves
- **Test:** Full frontmatter populated, pending review items created

### Phase 5: Polish & Expand
- **Specs:** All expanded
- **Goal:** Curator agent, reverse sync, two_pass/single_pass strategies, import providers, advanced Bases
- **Not in MVP**

## Key Architectural Decisions

1. **CLI-only (no HTTP, no MCP)** — simplest correct architecture for single-user
2. **Claude Code CLI as AI executor** — uses personal subscription, `--json-schema` for structured output
3. **SQLite is the system of record** — all machine state in SQLite; frontmatter is a read-only projection
4. **Bun-only runtime** — native TS, built-in SQLite, fast CLI. No Node fallback.
5. **Python sidecar for Marker** — managed via `uv`, pinned version, subprocess only. Provider interface designed-in for future parsers.
6. **Flat study notes + asset bundles** — `studies/{citekey}.md` + `_assets/{citekey}/`
7. **`siss_id` immutable, citekey mutable** — UUIDs for data integrity, citekeys for humans
8. **Time-windowed AI processing** — configurable windows, batch sizes, per-study token budget
9. **Strict single-writer mutation model** — one mutating process at a time via lockfile
10. **Piped AI strategy (MVP)** — summarizer surfaces structured extraction, classifier reads summary only. Two_pass and single_pass designed-in for benchmarking.
11. **Error classification** — transient vs permanent failures, AI stages default to 1 retry
12. **Taxonomy as evolving JSON** — machine-managed, human-approved, provisional values allowed with cleanup log
13. **No cascade by default** — reprocessing summary does not auto-trigger reclassification unless `--cascade`
14. **Upstream deletions are review flags** — deleted Zotero items are marked for manual review, not auto-removed
15. **Granular pipeline reporting** — per-step status map plus derived overall health
