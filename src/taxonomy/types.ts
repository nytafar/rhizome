import type { ClassifierTaxonomyGroup } from "../ai/schemas/classifier";

export const TAXONOMY_SCHEMA_VERSION = 1;

export type TaxonomyGroupName = ClassifierTaxonomyGroup;

export type TaxonomyProposalOperation = "rename" | "merge";

export type TaxonomyProposalDecisionStatus = "approved" | "rejected";

export type TaxonomyPropagationCheckpointStatus = "in_progress" | "completed" | "error";

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

export interface TaxonomyProposalDecisionRecord {
  proposal_id: string;
  operation_type: TaxonomyProposalOperation;
  group_name: TaxonomyGroupName;
  source_value: string;
  target_value: string;
  decision_status: TaxonomyProposalDecisionStatus;
  decided_by?: string;
  rationale?: string;
  decided_at: string;
  updated_at: string;
}

export interface TaxonomyCheckpointCursor {
  note_paths: string[];
  current_index: number;
}

export interface TaxonomyPropagationCheckpointRecord {
  checkpoint_id: string;
  proposal_id: string;
  status: TaxonomyPropagationCheckpointStatus;
  cursor: TaxonomyCheckpointCursor;
  processed_notes: number;
  total_notes: number;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  last_error?: string;
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
