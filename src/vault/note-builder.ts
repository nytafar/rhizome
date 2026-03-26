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

function buildSummaryVersions(study: StudyRecord): string[] | undefined {
  if (!study.summary_path) {
    return undefined;
  }

  return [formatWikilink(study.summary_path, "current")];
}

function buildStudyFrontmatter(study: StudyRecord): StudyFrontmatterProjection {
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
    summary_versions: buildSummaryVersions(study),
  });
}

export function buildStudyNoteMarkdown(study: StudyRecord): string {
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

  return matter.stringify(content, buildStudyFrontmatter(study));
}
