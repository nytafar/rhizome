import type {
  PipelineOverallStatus,
  PipelineStepState,
} from "./pipeline";

export interface Author {
  family: string;
  given: string;
}

export interface ProvisionalTaxonomyValue {
  group: string;
  value: string;
  confidence: number;
  proposed_by: string;
  logged_at: string;
}

export interface ClassifierTier4 {
  study_type: string | null;
  sample_size: number | null;
  duration_weeks: number | null;
  population: string | null;
  control: string | null;
  blinding: string | null;
  primary_outcome: string | null;
  outcome_direction: "positive" | "negative" | "neutral" | "mixed" | null;
  effect_size: string | null;
  significance: string | null;
  evidence_quality: "high" | "moderate" | "low" | null;
  funding_source: string | null;
  conflict_of_interest: boolean | null;
}

export interface ClassifierTier5 {
  herb_species: string[];
  common_names: string[];
  active_compounds: string[];
  plant_parts: string[];
  extraction_types: string[];
  dosages: string[];
  adverse_events: string[];
  safety_rating: "good" | "caution" | "contraindicated" | null;
}

export interface ClassifierTier6Taxonomy {
  therapeutic_areas: string[];
  mechanisms: string[];
  indications: string[];
  contraindications: string[];
  drug_interactions: string[];
  research_gaps: string[];
}

export interface StudyRecord {
  // === Identity ===
  siss_id: string;
  citekey: string;

  // === Bibliographic (Zotero-authoritative) ===
  title: string;
  authors: Author[];
  year: number;
  journal?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  abstract?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  url?: string;
  item_type?: string;

  // === Zotero Sync ===
  zotero_key?: string;
  zotero_version?: number;
  zotero_sync_status?: "active" | "removed_upstream";
  removed_upstream_at?: string | null;
  removed_upstream_reason?: string | null;

  // === Pipeline State ===
  pipeline_overall: PipelineOverallStatus;
  pipeline_steps: Record<string, PipelineStepState>;
  pipeline_error?: string | null;
  last_pipeline_run?: string;

  // === Asset Paths (relative to vault root) ===
  asset_dir?: string;
  pdf_path?: string;
  fulltext_path?: string;
  summary_path?: string;

  // === PDF Metadata ===
  pdf_available: boolean;
  pdf_source?: "zotero" | "europepmc" | "unpaywall" | "openalex" | "manual";

  // === AI Provenance ===
  summary_skill_version?: string;
  classifier_skill_version?: string;
  summary_model?: string;
  classifier_model?: string;
  summary_generated_at?: string;
  classifier_generated_at?: string;
  tier_4?: ClassifierTier4;
  tier_5?: ClassifierTier5;
  tier_6_taxonomy?: ClassifierTier6Taxonomy;
  tier_7_provisional?: ProvisionalTaxonomyValue[];
  taxonomy_provisional?: ProvisionalTaxonomyValue[];

  // === Source Tracking ===
  source: string;
  source_collections?: string[];
  source_tags?: string[];
  date_added?: string;
}

// Projection boundary for note frontmatter serialization/parsing.
// Keep this separate from StudyRecord so orchestration/DB internals can evolve
// independently of the markdown contract.
export interface StudyFrontmatterProjection {
  // Identity
  rhizome_id?: string;
  note_type: "study";

  // Pipeline surface
  has_pdf: boolean;
  has_fulltext: boolean;
  has_summary: boolean;
  has_classification: boolean;
  pipeline_status: "complete" | "partial" | "failed" | "pending";
  pipeline_error?: string | null;
  last_pipeline_run?: string;

  // Bibliographic
  title: string;
  authors: Author[];
  year: number;
  journal?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  abstract?: string;
  url?: string;
  item_type?: string;

  // Zotero
  zotero_key?: string;
  source_collections?: string[];

  // Tags
  tags?: string[];

  // Assets (wikilinks)
  pdf?: string;
  fulltext?: string;
  summary?: string;
  user_note?: string | null;
  pdf_available: boolean;
  pdf_source?: "zotero" | "europepmc" | "unpaywall" | "openalex" | "manual";

  // AI provenance
  summary_skill?: string;
  classifier_skill?: string;
  summary_generated_at?: string;
  classifier_generated_at?: string;
  tier_4?: ClassifierTier4;
  tier_5?: ClassifierTier5;
  tier_6_taxonomy?: ClassifierTier6Taxonomy;
  tier_7_provisional?: ProvisionalTaxonomyValue[];
  summary_versions?: string[];

  // User fields
  user_rating?: number | null;
  user_priority?: "high" | "medium" | "low" | null;
  user_status?: "reading" | "read" | "flagged" | null;
  notes?: string;
}
