import { z } from "zod";

export const classifierTaxonomyGroups = [
  "therapeutic_areas",
  "mechanisms",
  "indications",
  "contraindications",
  "drug_interactions",
  "research_gaps",
] as const;

export type ClassifierTaxonomyGroup = (typeof classifierTaxonomyGroups)[number];

const taxonomyArraySchema = {
  type: "array",
  items: { type: "string" },
} as const;

const provisionalCandidateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["group", "value", "confidence"],
  properties: {
    group: {
      type: "string",
      enum: [...classifierTaxonomyGroups],
    },
    value: {
      type: "string",
      pattern: "^new:.+",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
  },
} as const;

export const classifierJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "tier_4", "tier_5", "tier_6_taxonomy", "tier_7_provisional"],
  properties: {
    source: {
      type: "string",
      enum: ["fulltext", "abstract_only"],
      description: "What evidence source was used for this output",
    },
    tier_4: {
      type: "object",
      additionalProperties: false,
      required: [
        "study_type",
        "sample_size",
        "duration_weeks",
        "population",
        "control",
        "blinding",
        "primary_outcome",
        "outcome_direction",
        "effect_size",
        "significance",
        "evidence_quality",
        "funding_source",
        "conflict_of_interest",
      ],
      properties: {
        study_type: { type: ["string", "null"] },
        sample_size: { type: ["integer", "null"] },
        duration_weeks: { type: ["number", "null"] },
        population: { type: ["string", "null"] },
        control: { type: ["string", "null"] },
        blinding: { type: ["string", "null"] },
        primary_outcome: { type: ["string", "null"] },
        outcome_direction: {
          type: ["string", "null"],
          enum: ["positive", "negative", "neutral", "mixed", null],
        },
        effect_size: { type: ["string", "null"] },
        significance: { type: ["string", "null"] },
        evidence_quality: {
          type: ["string", "null"],
          enum: ["high", "moderate", "low", null],
        },
        funding_source: { type: ["string", "null"] },
        conflict_of_interest: { type: ["boolean", "null"] },
      },
    },
    tier_5: {
      type: "object",
      additionalProperties: false,
      required: [
        "herb_species",
        "common_names",
        "active_compounds",
        "plant_parts",
        "extraction_types",
        "dosages",
        "adverse_events",
        "safety_rating",
      ],
      properties: {
        herb_species: taxonomyArraySchema,
        common_names: taxonomyArraySchema,
        active_compounds: taxonomyArraySchema,
        plant_parts: taxonomyArraySchema,
        extraction_types: taxonomyArraySchema,
        dosages: taxonomyArraySchema,
        adverse_events: taxonomyArraySchema,
        safety_rating: {
          type: ["string", "null"],
          enum: ["good", "caution", "contraindicated", null],
        },
      },
    },
    tier_6_taxonomy: {
      type: "object",
      additionalProperties: false,
      required: [...classifierTaxonomyGroups],
      properties: {
        therapeutic_areas: taxonomyArraySchema,
        mechanisms: taxonomyArraySchema,
        indications: taxonomyArraySchema,
        contraindications: taxonomyArraySchema,
        drug_interactions: taxonomyArraySchema,
        research_gaps: taxonomyArraySchema,
      },
    },
    tier_7_provisional: {
      type: "array",
      maxItems: 100,
      items: provisionalCandidateJsonSchema,
    },
  },
} as const;

const provisionalCandidateSchema = z
  .object({
    group: z.enum(classifierTaxonomyGroups),
    value: z.string().regex(/^new:.+/, "provisional values must use new:<value> format"),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const classifierOutputSchema = z
  .object({
    source: z.enum(["fulltext", "abstract_only"]),
    tier_4: z
      .object({
        study_type: z.string().nullable(),
        sample_size: z.number().int().nullable(),
        duration_weeks: z.number().nullable(),
        population: z.string().nullable(),
        control: z.string().nullable(),
        blinding: z.string().nullable(),
        primary_outcome: z.string().nullable(),
        outcome_direction: z
          .enum(["positive", "negative", "neutral", "mixed"])
          .nullable(),
        effect_size: z.string().nullable(),
        significance: z.string().nullable(),
        evidence_quality: z.enum(["high", "moderate", "low"]).nullable(),
        funding_source: z.string().nullable(),
        conflict_of_interest: z.boolean().nullable(),
      })
      .strict(),
    tier_5: z
      .object({
        herb_species: z.array(z.string()),
        common_names: z.array(z.string()),
        active_compounds: z.array(z.string()),
        plant_parts: z.array(z.string()),
        extraction_types: z.array(z.string()),
        dosages: z.array(z.string()),
        adverse_events: z.array(z.string()),
        safety_rating: z.enum(["good", "caution", "contraindicated"]).nullable(),
      })
      .strict(),
    tier_6_taxonomy: z
      .object({
        therapeutic_areas: z.array(z.string()),
        mechanisms: z.array(z.string()),
        indications: z.array(z.string()),
        contraindications: z.array(z.string()),
        drug_interactions: z.array(z.string()),
        research_gaps: z.array(z.string()),
      })
      .strict(),
    tier_7_provisional: z.array(provisionalCandidateSchema).max(100),
  })
  .strict();

export type ClassifierJsonSchema = typeof classifierJsonSchema;
export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;

export function parseClassifierOutput(payload: unknown): ClassifierOutput {
  return classifierOutputSchema.parse(payload);
}

export function parseClassifierStdout(stdout: string): ClassifierOutput {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Classifier output must be valid JSON: ${String(error)}`);
  }

  return parseClassifierOutput(parsed);
}
