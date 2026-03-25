import { z } from "zod";
import {
  PipelineOverallStatus,
  PipelineStepStatus,
  type PipelineStepState,
} from "../types/pipeline";
import type { Author, StudyRecord } from "../types/study";

const isoDateTimeSchema = z.iso.datetime();
const isoDateSchema = z.iso.date();

export const AuthorSchema: z.ZodType<Author> = z
  .object({
    family: z.string().min(1),
    given: z.string().min(1),
  })
  .strict();

export const PipelineStepStateSchema: z.ZodType<PipelineStepState> = z
  .object({
    status: z.nativeEnum(PipelineStepStatus),
    updated_at: isoDateTimeSchema,
    retries: z.number().int().min(0),
    error: z.string().min(1).optional(),
    skip_reason: z.string().min(1).optional(),
    duration_ms: z.number().int().min(0).optional(),
  })
  .strict();

export const StudyFrontmatterSchema: z.ZodType<StudyRecord & { note_type: "study" }> =
  z
    .object({
      // Tier 0: Identity + Pipeline
      siss_id: z.uuid(),
      citekey: z.string().min(1),
      note_type: z.literal("study"),
      pipeline_overall: z.nativeEnum(PipelineOverallStatus),
      pipeline_steps: z.record(z.string(), PipelineStepStateSchema),
      pipeline_error: z.string().min(1).nullable().optional(),
      last_pipeline_run: isoDateSchema.optional(),

      // Tier 1: Bibliographic
      title: z.string().min(1),
      authors: z.array(AuthorSchema).min(1),
      year: z.number().int().gt(1900),
      journal: z.string().min(1).optional(),
      doi: z.string().min(1).optional(),
      pmid: z.string().min(1).optional(),
      pmcid: z.string().min(1).optional(),
      isbn: z.string().min(1).optional(),
      abstract: z.string().min(1).optional(),
      volume: z.string().min(1).optional(),
      issue: z.string().min(1).optional(),
      pages: z.string().min(1).optional(),
      url: z.url().optional(),
      item_type: z.string().min(1).optional(),

      // Tier 2: Zotero Sync
      zotero_key: z.string().min(1).optional(),
      zotero_version: z.number().int().min(0).optional(),
      zotero_sync_status: z.enum(["active", "removed_upstream"]).optional(),
      removed_upstream_at: isoDateTimeSchema.nullable().optional(),
      removed_upstream_reason: z.string().min(1).nullable().optional(),
      source: z.string().min(1),
      source_collections: z.array(z.string().min(1)).optional(),
      source_tags: z.array(z.string().min(1)).optional(),
      date_added: isoDateTimeSchema.optional(),

      // Tier 3: Assets
      asset_dir: z.string().min(1).optional(),
      pdf_path: z.string().min(1).optional(),
      pdf_available: z.boolean(),
      pdf_source: z
        .enum(["zotero", "europepmc", "unpaywall", "openalex", "manual"])
        .optional(),
      fulltext_path: z.string().min(1).optional(),
      summary_path: z.string().min(1).optional(),
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
