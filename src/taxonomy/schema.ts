import { z } from "zod";
import {
  classifierTaxonomyGroups,
  type ClassifierTaxonomyGroup,
} from "../ai/schemas/classifier";
import {
  TAXONOMY_SCHEMA_VERSION,
  type TaxonomyDocument,
  type TaxonomyGroupName,
  type TaxonomyGroupState,
  type TaxonomyPendingEntry,
  type TaxonomyValueEntry,
} from "./types";

const isoDateTimeSchema = z.iso.datetime();

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
