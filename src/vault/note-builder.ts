import matter from "gray-matter";
import type { StudyRecord } from "../types/study";

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

function renderAssetLinks(study: StudyRecord): string {
  const summaryLink = study.summary_path
    ? formatWikilink(study.summary_path, "AI Summary")
    : "_Not available_";
  const pdfLink = study.pdf_path
    ? formatWikilink(study.pdf_path, "PDF")
    : "_Not available_";
  const fulltextLink = study.fulltext_path
    ? formatWikilink(study.fulltext_path, "Full Text")
    : "_Not available_";
  const zoteroLink = study.zotero_key
    ? `[Open in Zotero](zotero://select/items/${study.zotero_key})`
    : "_Not available_";

  return [
    `- ${pdfLink}`,
    `- ${fulltextLink}`,
    `- ${summaryLink}`,
    `- ${zoteroLink}`,
  ].join("\n");
}

function renderVersionHistory(study: StudyRecord): string {
  const summaryDate = study.summary_generated_at ?? UNAVAILABLE;
  const summarySkill = study.summary_skill_version ?? UNAVAILABLE;
  const summaryModel = study.summary_model ?? UNAVAILABLE;

  const classifyDate = study.classifier_generated_at ?? UNAVAILABLE;
  const classifySkill = study.classifier_skill_version ?? UNAVAILABLE;
  const classifyModel = study.classifier_model ?? UNAVAILABLE;

  return [
    "| Date | Stage | Skill Version | Model |",
    "|---|---|---|---|",
    `| ${summaryDate} | summary | ${summarySkill} | ${summaryModel} |`,
    `| ${classifyDate} | classify | ${classifySkill} | ${classifyModel} |`,
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

function buildStudyFrontmatter(study: StudyRecord) {
  return cleanUndefinedDeep({
    siss_id: study.siss_id,
    citekey: study.citekey,
    note_type: "study" as const,
    pipeline_overall: study.pipeline_overall,
    pipeline_steps: study.pipeline_steps,
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
    volume: study.volume,
    issue: study.issue,
    pages: study.pages,
    url: study.url,
    item_type: study.item_type,

    zotero_key: study.zotero_key,
    zotero_version: study.zotero_version,
    zotero_sync_status: study.zotero_sync_status,
    removed_upstream_at: study.removed_upstream_at,
    removed_upstream_reason: study.removed_upstream_reason,

    source: study.source,
    source_collections: study.source_collections,
    source_tags: study.source_tags,
    date_added: study.date_added,

    asset_dir: study.asset_dir,
    pdf_path: study.pdf_path,
    pdf_available: study.pdf_available,
    pdf_source: study.pdf_source,
    fulltext_path: study.fulltext_path,
    summary_path: study.summary_path,

  });
}

export function buildStudyNoteMarkdown(study: StudyRecord): string {
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
    "## Assets",
    renderAssetLinks(study),
    "",
    "## Version History",
    renderVersionHistory(study),
    "",
  ].join("\n");

  return matter.stringify(content, buildStudyFrontmatter(study));
}
