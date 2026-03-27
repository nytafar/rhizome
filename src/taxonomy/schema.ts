import { z } from "zod";
import {
  classifierTaxonomyGroups,
  type ClassifierTaxonomyGroup,
} from "../ai/schemas/classifier";
import {
  TAXONOMY_SCHEMA_VERSION,
  type TaxonomyCheckpointCursor,
  type TaxonomyDocument,
  type TaxonomyGroupName,
  type TaxonomyGroupState,
  type TaxonomyPendingEntry,
  type TaxonomyPropagationCheckpointRecord,
  type TaxonomyProposalDecisionRecord,
  type TaxonomyValueEntry,
} from "./types";

const isoDateTimeSchema = z.iso.datetime();
const nonEmptyTrimmedSchema = z.string().trim().min(1);

export const taxonomyProposalIdSchema = z
  .string()
  .trim()
  .regex(/^proposal:[a-z0-9_-]+:[a-z0-9_-]+:[a-z0-9_-]+$/, "Invalid taxonomy proposal id format");

export const taxonomyOperationTypeSchema = z.enum(["rename", "merge"]);

export const taxonomyDecisionStatusSchema = z.enum(["approved", "rejected"]);

export const taxonomyCheckpointStatusSchema = z.enum(["in_progress", "completed", "error"]);

const taxonomyValueEntrySchema: z.ZodType<TaxonomyValueEntry> = z
  .object({
    count: z.number().int().nonnegative(),
    last_used_at: isoDateTimeSchema,
    aliases: z.array(z.string().min(1)),
    created_at: isoDateTimeSchema,
    promoted_at: isoDateTimeSchema.optional(),
    promoted_sources: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine(
    (entry) => new Set(entry.aliases).size === entry.aliases.length,
    "aliases must be unique",
  )
  .refine(
    (entry) =>
      !entry.promoted_sources
      || new Set(entry.promoted_sources).size === entry.promoted_sources.length,
    "promoted_sources must be unique",
  );

const taxonomyPendingEntrySchema: z.ZodType<TaxonomyPendingEntry> = z
  .object({
    count: z.number().int().positive(),
    first_seen_at: isoDateTimeSchema,
    last_seen_at: isoDateTimeSchema,
    sources: z.array(z.string().min(1)),
  })
  .strict()
  .refine(
    (entry) => new Set(entry.sources).size === entry.sources.length,
    "sources must be unique",
  );

const taxonomyGroupStateSchema: z.ZodType<TaxonomyGroupState> = z
  .object({
    values: z.record(z.string().min(1), taxonomyValueEntrySchema),
    pending: z.record(z.string().min(1), taxonomyPendingEntrySchema),
  })
  .strict();

function buildGroupsObjectSchema(groups: readonly TaxonomyGroupName[]) {
  const shape: Record<TaxonomyGroupName, z.ZodType<TaxonomyGroupState>> = {} as Record<
    TaxonomyGroupName,
    z.ZodType<TaxonomyGroupState>
  >;

  for (const group of groups) {
    shape[group] = taxonomyGroupStateSchema;
  }

  return z.object(shape).strict();
}

export function createTaxonomyDocumentSchema(groups: readonly TaxonomyGroupName[]) {
  return z
    .object({
      version: z.literal(TAXONOMY_SCHEMA_VERSION),
      groups: buildGroupsObjectSchema(groups),
    })
    .strict() satisfies z.ZodType<TaxonomyDocument>;
}

export const taxonomyProposalDecisionRecordSchema: z.ZodType<TaxonomyProposalDecisionRecord> = z
  .object({
    proposal_id: taxonomyProposalIdSchema,
    operation_type: taxonomyOperationTypeSchema,
    group_name: z.enum(classifierTaxonomyGroups),
    source_value: nonEmptyTrimmedSchema,
    target_value: nonEmptyTrimmedSchema,
    decision_status: taxonomyDecisionStatusSchema,
    decided_by: nonEmptyTrimmedSchema.optional(),
    rationale: nonEmptyTrimmedSchema.optional(),
    decided_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .strict();

export const taxonomyCheckpointCursorSchema: z.ZodType<TaxonomyCheckpointCursor> = z
  .object({
    note_paths: z.array(nonEmptyTrimmedSchema),
    current_index: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((cursor, context) => {
    if (cursor.current_index > cursor.note_paths.length) {
      context.addIssue({
        code: "custom",
        message: "current_index cannot exceed note_paths length",
        path: ["current_index"],
      });
    }
  });

export const taxonomyPropagationCheckpointRecordSchema: z.ZodType<TaxonomyPropagationCheckpointRecord> = z
  .object({
    checkpoint_id: nonEmptyTrimmedSchema,
    proposal_id: taxonomyProposalIdSchema,
    status: taxonomyCheckpointStatusSchema,
    cursor: taxonomyCheckpointCursorSchema,
    processed_notes: z.number().int().nonnegative(),
    total_notes: z.number().int().nonnegative(),
    started_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
    completed_at: isoDateTimeSchema.optional(),
    last_error: nonEmptyTrimmedSchema.optional(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (checkpoint.processed_notes > checkpoint.total_notes) {
      context.addIssue({
        code: "custom",
        message: "processed_notes cannot exceed total_notes",
        path: ["processed_notes"],
      });
    }

    if (checkpoint.status === "completed" && !checkpoint.completed_at) {
      context.addIssue({
        code: "custom",
        message: "completed checkpoints require completed_at",
        path: ["completed_at"],
      });
    }

    if (checkpoint.status !== "completed" && checkpoint.completed_at) {
      context.addIssue({
        code: "custom",
        message: "only completed checkpoints may set completed_at",
        path: ["completed_at"],
      });
    }

    if (checkpoint.status === "error" && !checkpoint.last_error) {
      context.addIssue({
        code: "custom",
        message: "error checkpoints require last_error",
        path: ["last_error"],
      });
    }
  });

export function createEmptyTaxonomyState(groups: readonly TaxonomyGroupName[]): TaxonomyDocument {
  const grouped = Object.fromEntries(
    groups.map((group) => [group, { values: {}, pending: {} }]),
  ) as Record<TaxonomyGroupName, TaxonomyGroupState>;

  return {
    version: TAXONOMY_SCHEMA_VERSION,
    groups: grouped,
  };
}

export function validateConfiguredTaxonomyGroups(
  groups: readonly { name: string }[],
): readonly ClassifierTaxonomyGroup[] {
  const configuredNames = groups.map((group) => group.name);
  const configuredSet = new Set(configuredNames);
  const canonicalSet = new Set<string>(classifierTaxonomyGroups);

  const unknown = configuredNames.filter((name) => !canonicalSet.has(name));
  if (unknown.length > 0) {
    throw new Error(`Taxonomy group config contains unsupported groups: ${unknown.join(", ")}`);
  }

  const missing = classifierTaxonomyGroups.filter((name) => !configuredSet.has(name));
  if (missing.length > 0) {
    throw new Error(`Taxonomy group config is missing required groups: ${missing.join(", ")}`);
  }

  return [...classifierTaxonomyGroups];
}
