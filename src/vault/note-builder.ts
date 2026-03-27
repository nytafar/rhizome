import matter from "gray-matter";
import {
  PipelineOverallStatus,
  PipelineStep,
  PipelineStepStatus,
} from "../types/pipeline";
import type {
  StudyFrontmatterProjection,
  StudyRecord,
} from "../types/study";

const UNAVAILABLE = "—";

export const USER_PRESERVED_FRONTMATTER_KEYS = [
  "tags",
  "user_rating",
  "user_priority",
  "user_status",
  "user_note",
  "notes",
] as const;

export type UserPreservedFrontmatterKey =
  (typeof USER_PRESERVED_FRONTMATTER_KEYS)[number];

function cleanUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cleanUndefinedDeep(item)) as T;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, cleanUndefinedDeep(entryValue)]);

    return Object.fromEntries(entries) as T;
  }

  return value;
}

function formatCalloutBody(text: string | undefined): string {
  const normalized = text?.trim();
  if (!normalized) {
    return "> Abstract unavailable.";
  }

  return normalized
    .split("\n")
    .map((line) => `> ${line.trim()}`)
    .join("\n");
}

function formatWikilink(path: string, label: string): string {
  return `[[${path}|${label}]]`;
}

function summaryEmbedTarget(summaryPath: string): string {
  return summaryPath.endsWith(".md")
    ? summaryPath.slice(0, -3)
    : summaryPath;
}

function readOptionalStudyField(study: StudyRecord, key: string): string | undefined {
  const value = (study as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalStudyNumber(study: StudyRecord, key: string): number | undefined {
  const value = (study as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function renderSnapshotRows(study: StudyRecord): string {
  const studyType = readOptionalStudyField(study, "study_type") ?? UNAVAILABLE;
  const population = readOptionalStudyField(study, "population") ?? UNAVAILABLE;
  const durationWeeks = readOptionalStudyNumber(study, "duration_weeks");
  const sampleSize = readOptionalStudyNumber(study, "sample_size");
  const outcomeDirection = readOptionalStudyField(study, "outcome_direction");
  const effectSize = readOptionalStudyField(study, "effect_size");
  const evidenceQuality =
    readOptionalStudyField(study, "evidence_quality") ?? UNAVAILABLE;

  const duration =
    durationWeeks !== undefined ? `${durationWeeks.toString()} weeks` : UNAVAILABLE;
  const sample = sampleSize !== undefined ? `n=${sampleSize.toString()}` : UNAVAILABLE;

  const outcome = outcomeDirection
    ? effectSize
      ? `${outcomeDirection} (${effectSize})`
      : outcomeDirection
    : UNAVAILABLE;

  return [
    "| | |",
    "|---|---|",
    `| **Type** | ${studyType} |`,
    `| **Population** | ${population} |`,
    `| **Duration** | ${duration} |`,
    `| **Sample** | ${sample} |`,
    `| **Outcome** | ${outcome} |`,
    `| **Evidence** | ${evidenceQuality} |`,
  ].join("\n");
}

function normalizeSkillLabel(stage: "summary" | "classify", version?: string): string {
  if (!version) {
    return UNAVAILABLE;
  }

  if (version.includes("@")) {
    return version;
  }

  return `${stage === "summary" ? "summarizer" : "classifier"}@${version}`;
}

function renderVersionHistory(study: StudyRecord): string {
  const summaryDate = study.summary_generated_at ?? UNAVAILABLE;
  const summarySkill = normalizeSkillLabel("summary", study.summary_skill_version);

  const classifyDate = study.classifier_generated_at ?? UNAVAILABLE;
  const classifySkill = normalizeSkillLabel("classify", study.classifier_skill_version);

  return [
    "| Date | Stage | Skill |",
    "|---|---|---|",
    `| ${summaryDate} | summary | ${summarySkill} |`,
    `| ${classifyDate} | classify | ${classifySkill} |`,
  ].join("\n");
}

function renderSummaryEmbeds(study: StudyRecord): string {
  if (!study.summary_path) {
    return [
      "## TL;DR",
      "_Summary not available yet._",
      "",
      "## Key Findings",
      "_Summary not available yet._",
    ].join("\n");
  }

  const target = summaryEmbedTarget(study.summary_path);

  return [
    "## TL;DR",
    `![[${target}#TL;DR]]`,
    "",
    "## Key Findings",
    `![[${target}#Key Findings]]`,
  ].join("\n");
}

function resolveFrontmatterIdentity(study: StudyRecord): string | undefined {
  const rhizomeId = (study as StudyRecord & { rhizome_id?: string }).rhizome_id;
  return rhizomeId ?? study.siss_id;
}

function derivePipelineStatus(
  overall: PipelineOverallStatus,
): StudyFrontmatterProjection["pipeline_status"] {
  switch (overall) {
    case PipelineOverallStatus.COMPLETE:
      return "complete";
    case PipelineOverallStatus.NEEDS_ATTENTION:
      return "failed";
    case PipelineOverallStatus.NOT_STARTED:
      return "pending";
    case PipelineOverallStatus.IN_PROGRESS:
    default:
      return "partial";
  }
}

function hasClassificationSignal(study: StudyRecord): boolean {
  const classifyStatus = study.pipeline_steps[PipelineStep.CLASSIFY]?.status;
  return classifyStatus === PipelineStepStatus.COMPLETE || Boolean(study.classifier_generated_at);
}

function parseSummaryVersionPath(pathValue: string):
  | { path: string; label: string; order: number }
  | undefined {
  const normalizedPath = pathValue.trim();
  if (!normalizedPath) {
    return undefined;
  }

  if (normalizedPath.endsWith("summary.current.md")) {
    return {
      path: normalizedPath,
      label: "current",
      order: Number.POSITIVE_INFINITY,
    };
  }

  const versionMatch = /summary\.v(\d+)\.md$/.exec(normalizedPath);
  if (!versionMatch) {
    return undefined;
  }

  const version = Number.parseInt(versionMatch[1], 10);
  if (!Number.isInteger(version) || version <= 0) {
    return undefined;
  }

  return {
    path: normalizedPath,
    label: `v${version.toString()}`,
    order: version,
  };
}

function buildSummaryVersions(study: StudyRecord): string[] | undefined {
  const candidates = new Map<string, { label: string; order: number }>();

  const discovered = study.summary_versions ?? [];
  for (const entry of discovered) {
    const parsed = parseSummaryVersionPath(entry);
    if (!parsed) {
      continue;
    }

    candidates.set(parsed.path, { label: parsed.label, order: parsed.order });
  }

  if (study.summary_path) {
    const current = parseSummaryVersionPath(study.summary_path);
    if (current) {
      candidates.set(current.path, { label: current.label, order: current.order });
    }
  }

  if (candidates.size === 0) {
    return undefined;
  }

  return [...candidates.entries()]
    .sort((a, b) => {
      if (a[1].order !== b[1].order) {
        return a[1].order - b[1].order;
      }
      return a[0].localeCompare(b[0]);
    })
    .map(([path, meta]) => formatWikilink(path, meta.label));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function mergeFrontmatterProjection(params: {
  machine: StudyFrontmatterProjection;
  existing?: Partial<StudyFrontmatterProjection>;
}): StudyFrontmatterProjection {
  const { machine, existing } = params;

  if (!existing) {
    return machine;
  }

  const merged: StudyFrontmatterProjection = {
    ...machine,
  };

  if (isStringArray(existing.tags)) {
    merged.tags = [...existing.tags];
  }

  if ("user_rating" in existing) {
    merged.user_rating = existing.user_rating;
  }

  if ("user_priority" in existing) {
    merged.user_priority = existing.user_priority;
  }

  if ("user_status" in existing) {
    merged.user_status = existing.user_status;
  }

  if ("user_note" in existing) {
    merged.user_note = existing.user_note;
  }

  if ("notes" in existing) {
    merged.notes = existing.notes;
  }

  return cleanUndefinedDeep(merged);
}

export function buildStudyFrontmatterProjection(study: StudyRecord): StudyFrontmatterProjection {
  const includeRhizomeIdentity = !study.doi && !study.pmid;
  const rhizomeIdentity = includeRhizomeIdentity
    ? resolveFrontmatterIdentity(study)
    : undefined;

  return cleanUndefinedDeep({
    rhizome_id: rhizomeIdentity,
    note_type: "study" as const,

    has_pdf: study.pdf_available || Boolean(study.pdf_path),
    has_fulltext: Boolean(study.fulltext_path),
    has_summary: Boolean(study.summary_path),
    has_classification: hasClassificationSignal(study),
    pipeline_status: derivePipelineStatus(study.pipeline_overall),
    pipeline_error: study.pipeline_error,
    last_pipeline_run: study.last_pipeline_run,

    title: study.title,
    authors: study.authors,
    year: study.year,
    journal: study.journal,
    doi: study.doi,
    pmid: study.pmid,
    pmcid: study.pmcid,
    isbn: study.isbn,
    abstract: study.abstract,
    url: study.url,
    item_type: study.item_type,

    zotero_key: study.zotero_key,
    source_collections: study.source_collections,

    tags: study.source_tags,

    pdf: study.pdf_path ? formatWikilink(study.pdf_path, "PDF") : undefined,
    fulltext: study.fulltext_path
      ? formatWikilink(study.fulltext_path, "Full Text")
      : undefined,
    summary: study.summary_path
      ? formatWikilink(study.summary_path, "AI Summary")
      : undefined,
    user_note: null,
    pdf_available: study.pdf_available,
    pdf_source: study.pdf_source,

    summary_skill: normalizeSkillLabel("summary", study.summary_skill_version),
    classifier_skill: normalizeSkillLabel("classify", study.classifier_skill_version),
    summary_generated_at: study.summary_generated_at,
    classifier_generated_at: study.classifier_generated_at,
    tier_4: study.tier_4,
    tier_5: study.tier_5,
    tier_6_taxonomy: study.tier_6_taxonomy,
    tier_7_provisional: study.tier_7_provisional ?? study.taxonomy_provisional,
    summary_versions: buildSummaryVersions(study),
  });
}

export function buildStudyNoteMarkdown(
  study: StudyRecord,
  existingFrontmatter?: Partial<StudyFrontmatterProjection>,
): string {
  const zoteroLink = study.zotero_key
    ? `[Open in Zotero](zotero://select/items/${study.zotero_key})`
    : "_Not available_";

  const content = [
    `# ${study.title}`,
    "",
    "> [!abstract]",
    formatCalloutBody(study.abstract),
    "",
    "## Snapshot",
    renderSnapshotRows(study),
    "",
    renderSummaryEmbeds(study),
    "",
    "## Version History",
    renderVersionHistory(study),
    "",
    "## Links",
    `- ${zoteroLink}`,
    "",
  ].join("\n");

  const machineFrontmatter = buildStudyFrontmatterProjection(study);
  const finalFrontmatter = mergeFrontmatterProjection({
    machine: machineFrontmatter,
    existing: existingFrontmatter,
  });

  return matter.stringify(content, finalFrontmatter);
}
