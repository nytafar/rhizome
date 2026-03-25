export const summarizerJsonSchema = {
  type: "object",
  required: [
    "source",
    "tldr",
    "background",
    "methods",
    "key_findings",
    "clinical_relevance",
    "limitations",
  ],
  additionalProperties: false,
  properties: {
    source: {
      type: "string",
      enum: ["fulltext", "abstract_only"],
      description: "What evidence source was used for this output",
    },
    tldr: {
      type: "string",
      description: "2-3 sentence summary for quick scanning",
    },
    background: {
      type: "string",
      description: "Why this study was conducted, what gap it addresses",
    },
    methods: {
      type: "string",
      description: "Study design, population, interventions, measurements",
    },
    key_findings: {
      type: "string",
      description: "Structured findings with specific data points",
    },
    clinical_relevance: {
      type: "string",
      description: "Practical implications for clinicians and product developers",
    },
    limitations: {
      type: "string",
      description: "Methodological limitations and generalizability concerns",
    },
    compounds_and_doses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          compound: { type: "string" },
          dose: { type: "string" },
          frequency: { type: "string" },
          duration: { type: "string" },
        },
      },
    },
    open_questions: {
      type: "string",
      description: "What remains unanswered, suggested follow-up",
    },
    structured_extraction: {
      type: "object",
      description:
        "Machine-readable extraction of classifiable fields for downstream classifier (piped mode)",
      properties: {
        herb_species: { type: "array", items: { type: "string" } },
        common_names: { type: "array", items: { type: "string" } },
        active_compounds: { type: "array", items: { type: "string" } },
        plant_parts: { type: "array", items: { type: "string" } },
        extraction_types: { type: "array", items: { type: "string" } },
        dosages: { type: "array", items: { type: "string" } },
        adverse_events: { type: "array", items: { type: "string" } },
        study_type: { type: ["string", "null"] },
        sample_size: { type: ["integer", "null"] },
        duration: { type: ["string", "null"] },
        population: { type: ["string", "null"] },
      },
    },
  },
} as const;

export type SummarizerJsonSchema = typeof summarizerJsonSchema;
