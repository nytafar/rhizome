import type { Author, StudyRecord } from "../types/study";

export interface SummarizerInputStudy {
  title: StudyRecord["title"];
  authors: StudyRecord["authors"];
  year: StudyRecord["year"];
  journal?: StudyRecord["journal"];
  doi?: StudyRecord["doi"];
  pmid?: StudyRecord["pmid"];
  item_type?: StudyRecord["item_type"];
  abstract?: StudyRecord["abstract"];
}

function formatAuthors(authors: Author[]): string {
  if (authors.length === 0) {
    return "Unknown";
  }

  return authors
    .map((author) => `${author.given} ${author.family}`.trim())
    .join(", ");
}

function printField(label: string, value: string | number | undefined): string {
  if (value === undefined || value === null || value === "") {
    return `${label}: Unknown`;
  }

  return `${label}: ${value}`;
}

export function buildSummarizerInput(study: SummarizerInputStudy): string {
  return [
    "# Study Metadata",
    printField("Title", study.title),
    printField("Authors", formatAuthors(study.authors)),
    printField("Year", study.year),
    printField("Journal", study.journal),
    printField("DOI", study.doi),
    printField("PMID", study.pmid),
    printField("Study Type", study.item_type),
    "",
    "# Abstract",
    study.abstract?.trim() || "Full text not available. Abstract not provided.",
    "",
  ].join("\n");
}
