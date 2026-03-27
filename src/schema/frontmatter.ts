import { z } from "zod";
import type {
  Author,
  ClassifierTier4,
  ClassifierTier5,
  ClassifierTier6Taxonomy,
  ProvisionalTaxonomyValue,
  StudyFrontmatterProjection,
} from "../types/study";

const isoDateTimeSchema = z.iso.datetime();
const isoDateSchema = z.iso.date();

const wikilinkSchema = z.string().regex(/^\[\[[^\]]+\]\]$/, "Expected Obsidian wikilink format [[path|label]] or [[path]]");

export const AuthorSchema: z.ZodType<Author> = z
  .object({
    family: z.string().min(1),
    given: z.string().min(1),
  })
  .strict();

export const Tier4Schema: z.ZodType<ClassifierTier4> = z
  .object({
    study_type: z.string().nullable(),
    sample_size: z.number().int().nullable(),
    duration_weeks: z.number().nullable(),
    population: z.string().nullable(),
    control: z.string().nullable(),
    blinding: z.string().nullable(),
    primary_outcome: z.string().nullable(),
    outcome_direction: z.enum(["positive", "negative", "neutral", "mixed"]).nullable(),
    effect_size: z.string().nullable(),
    significance: z.string().nullable(),
    evidence_quality: z.enum(["high", "moderate", "low"]).nullable(),
    funding_source: z.string().nullable(),
    conflict_of_interest: z.boolean().nullable(),
  })
  .strict();

export const Tier5Schema: z.ZodType<ClassifierTier5> = z
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
  .strict();

export const Tier6TaxonomySchema: z.ZodType<ClassifierTier6Taxonomy> = z
  .object({
    therapeutic_areas: z.array(z.string()),
    mechanisms: z.array(z.string()),
    indications: z.array(z.string()),
    contraindications: z.array(z.string()),
    drug_interactions: z.array(z.string()),
    research_gaps: z.array(z.string()),
  })
  .strict();

export const Tier7ProvisionalCandidateSchema: z.ZodType<ProvisionalTaxonomyValue> = z
  .object({
    group: z.string().min(1),
    value: z.string().regex(/^new:.+/, "provisional values must use new:<value> format"),
    confidence: z.number().min(0).max(1),
    proposed_by: z.string().min(1),
    logged_at: isoDateTimeSchema,
  })
  .strict();

export const StudyFrontmatterSchema: z.ZodType<StudyFrontmatterProjection> = z
  .object({
    // Identity
    rhizome_id: z.uuid().optional(),
    note_type: z.literal("study"),

    // Pipeline surface
    has_pdf: z.boolean(),
    has_fulltext: z.boolean(),
    has_summary: z.boolean(),
    has_classification: z.boolean(),
    pipeline_status: z.enum(["complete", "partial", "failed", "pending"]),
    pipeline_error: z.string().min(1).nullable().optional(),
    last_pipeline_run: isoDateSchema.optional(),

    // Bibliographic
    title: z.string().min(1),
    authors: z.array(AuthorSchema).min(1),
    year: z.number().int().gt(1900),
    journal: z.string().min(1).optional(),
    doi: z.string().min(1).optional(),
    pmid: z.string().min(1).optional(),
    pmcid: z.string().min(1).optional(),
    isbn: z.string().min(1).optional(),
    abstract: z.string().min(1).optional(),
    url: z.url().optional(),
    item_type: z.string().min(1).optional(),

    // Zotero
    zotero_key: z.string().min(1).optional(),
    source_collections: z.array(z.string().min(1)).optional(),

    // Tags
    tags: z.array(z.string().min(1)).optional(),

    // Assets (wikilinks)
    pdf: wikilinkSchema.optional(),
    fulltext: wikilinkSchema.optional(),
    summary: wikilinkSchema.optional(),
    user_note: wikilinkSchema.nullable().optional(),
    pdf_available: z.boolean(),
    pdf_source: z
      .enum(["zotero", "europepmc", "unpaywall", "openalex", "manual"])
      .optional(),

    // AI provenance
    summary_skill: z.string().min(1).optional(),
    classifier_skill: z.string().min(1).optional(),
    summary_generated_at: isoDateTimeSchema.optional(),
    classifier_generated_at: isoDateTimeSchema.optional(),
    tier_4: Tier4Schema.optional(),
    tier_5: Tier5Schema.optional(),
    tier_6_taxonomy: Tier6TaxonomySchema.optional(),
    tier_7_provisional: z.array(Tier7ProvisionalCandidateSchema).max(100).optional(),
    summary_versions: z.array(wikilinkSchema).optional(),

    // User fields
    user_rating: z.number().int().min(1).max(5).nullable().optional(),
    user_priority: z.enum(["high", "medium", "low"]).nullable().optional(),
    user_status: z.enum(["reading", "read", "flagged"]).nullable().optional(),
    notes: z.string().optional(),
  })
  .strict();

export type StudyFrontmatter = z.infer<typeof StudyFrontmatterSchema>;

export function parseStudyFrontmatter(
  input: unknown,
): StudyFrontmatter {
  return StudyFrontmatterSchema.parse(input);
}

export function safeParseStudyFrontmatter(input: unknown) {
  return StudyFrontmatterSchema.safeParse(input);
}

export function isValidStudyFrontmatter(input: unknown): input is StudyFrontmatter {
  return safeParseStudyFrontmatter(input).success;
}
