export interface SummarizerCompoundDose {
  compound?: string;
  dose?: string;
  frequency?: string;
  duration?: string;
}

export interface StructuredExtraction {
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
  structured_extraction?: StructuredExtraction;
}

export interface SkillMeta {
  citekey: string;
  skillVersion: string;
  model: string;
  generatedAt: string;
}

function printCompoundsAndDoses(
  compoundsAndDoses: SummarizerCompoundDose[] | undefined,
): string {
  if (!compoundsAndDoses || compoundsAndDoses.length === 0) {
    return "Not applicable";
  }

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
  meta: SkillMeta,
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
${printCompoundsAndDoses(json.compounds_and_doses)}

## Open Questions
${json.open_questions || "None identified"}

## Structured Extraction
${printStructuredExtraction(json.structured_extraction)}
`;
}
