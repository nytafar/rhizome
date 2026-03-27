import type { ClassifierTaxonomyGroup } from "../ai/schemas/classifier";

export const TAXONOMY_SCHEMA_VERSION = 1;

export type TaxonomyGroupName = ClassifierTaxonomyGroup;

export interface TaxonomyValueEntry {
  count: number;
  last_used_at: string;
  aliases: string[];
  created_at: string;
  promoted_at?: string;
  promoted_sources?: string[];
}

export interface TaxonomyPendingEntry {
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  sources: string[];
}

export interface TaxonomyGroupState {
  values: Record<string, TaxonomyValueEntry>;
  pending: Record<string, TaxonomyPendingEntry>;
}

export interface TaxonomyDocument {
  version: number;
  groups: Record<TaxonomyGroupName, TaxonomyGroupState>;
}

export interface RecordUsageInput {
  group: TaxonomyGroupName;
  value: string;
  usedAt?: string;
}

export interface AddPendingInput {
  group: TaxonomyGroupName;
  value: string;
  source?: string;
  seenAt?: string;
}

export interface AutoPromoteInput {
  threshold: number;
  promotedAt?: string;
}

export interface AutoPromoteResult {
  state: TaxonomyDocument;
  promoted: Array<{
    group: TaxonomyGroupName;
    value: string;
    count: number;
    promoted_at: string;
    sources: string[];
  }>;
}

export interface AtomicFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
}
