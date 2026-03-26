export interface SummarizerCompoundDose {
  compound?: string;
  dose?: string;
  frequency?: string;
  duration?: string;
}

<<<<<<< HEAD
export interface SummarizerStructuredExtraction {
=======
export interface StructuredExtraction {
>>>>>>> milestone/M001
  herb_species?: string[];
  common_names?: string[];
  active_compounds?: string[];
  plant_parts?: string[];
  extraction_types?: string[];
  dosages?: string[];
  adverse_events?: string[];
  study_type?: string | null;
  sample_size?: number | null;
  duration?: string | null;
  population?: string | null;
}

export interface SummarizerOutput {
  source: "fulltext" | "abstract_only";
  tldr: string;
  background: string;
  methods: string;
  key_findings: string;
  clinical_relevance: string;
  limitations: string;
  compounds_and_doses?: SummarizerCompoundDose[];
  open_questions?: string;
<<<<<<< HEAD
  structured_extraction?: SummarizerStructuredExtraction;
}

export interface SummarySkillMeta {
=======
  structured_extraction?: StructuredExtraction;
}

export interface SkillMeta {
>>>>>>> milestone/M001
  citekey: string;
  skillVersion: string;
  model: string;
  generatedAt: string;
}

<<<<<<< HEAD
function formatCompoundDose(item: SummarizerCompoundDose): string {
  const compound = item.compound?.trim() || "Unknown compound";
  const dose = item.dose?.trim() || "unspecified dose";
  const frequency = item.frequency?.trim();
  const duration = item.duration?.trim() || "unspecified";

  const frequencyPart = frequency ? ` ${frequency}` : "";
  return `- **${compound}**: ${dose}${frequencyPart} for ${duration}`;
}

function compoundsSection(compoundsAndDoses?: SummarizerCompoundDose[]): string {
=======
function printCompoundsAndDoses(
  compoundsAndDoses: SummarizerCompoundDose[] | undefined,
): string {
>>>>>>> milestone/M001
  if (!compoundsAndDoses || compoundsAndDoses.length === 0) {
    return "Not applicable";
  }

<<<<<<< HEAD
  return compoundsAndDoses.map(formatCompoundDose).join("\n");
}

function structuredExtractionSection(
  structuredExtraction?: SummarizerStructuredExtraction,
=======
  return compoundsAndDoses
    .map((entry) => {
      const compound = entry.compound?.trim() || "Unspecified compound";
      const dose = entry.dose?.trim() || "unspecified dose";
      const frequency = entry.frequency?.trim();
      const duration = entry.duration?.trim() || "unspecified";

      return `- **${compound}**: ${dose}${frequency ? ` ${frequency}` : ""} for ${duration}`;
    })
    .join("\n");
}

function printStructuredExtraction(
  structuredExtraction: StructuredExtraction | undefined,
>>>>>>> milestone/M001
): string {
  if (!structuredExtraction) {
    return "Not provided";
  }

  return [
    "```json",
    JSON.stringify(structuredExtraction, null, 2),
    "```",
  ].join("\n");
}

export function summaryJsonToMarkdown(
  json: SummarizerOutput,
<<<<<<< HEAD
  meta: SummarySkillMeta,
=======
  meta: SkillMeta,
>>>>>>> milestone/M001
): string {
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
<<<<<<< HEAD
${compoundsSection(json.compounds_and_doses)}
=======
${printCompoundsAndDoses(json.compounds_and_doses)}
>>>>>>> milestone/M001

## Open Questions
${json.open_questions || "None identified"}

## Structured Extraction
<<<<<<< HEAD
${structuredExtractionSection(json.structured_extraction)}
=======
${printStructuredExtraction(json.structured_extraction)}
>>>>>>> milestone/M001
`;
}
