import { describe, expect, test } from "bun:test";
import {
  isValidStudyFrontmatter,
  parseStudyFrontmatter,
  safeParseStudyFrontmatter,
} from "../frontmatter";

function validFrontmatterFixture() {
  return {
    rhizome_id: "550e8400-e29b-41d4-a716-446655440000",
    note_type: "study" as const,

    has_pdf: true,
    has_fulltext: true,
    has_summary: true,
    has_classification: false,
    pipeline_status: "partial" as const,
    pipeline_error: null,
    last_pipeline_run: "2026-03-26",

    title: "Ashwagandha root extract reduces cortisol in chronically stressed adults",
    authors: [
      { family: "Smith", given: "J" },
      { family: "Patel", given: "R" },
    ],
    year: 2023,
    journal: "Phytomedicine",
    doi: "10.1016/j.phymed.2023.01.012",
    pmid: "37291847",
    item_type: "journalArticle",

    zotero_key: "ABC123",
    source_collections: ["Adaptogens", "Clinical Trials"],

    tags: ["ashwagandha", "cortisol"],

    pdf: "[[Research/studies/_assets/smith2023ashwagandha/source.pdf|PDF]]",
    fulltext: "[[Research/studies/_assets/smith2023ashwagandha/fulltext.md|Fulltext]]",
    summary: "[[Research/studies/_assets/smith2023ashwagandha/summary.current.md|Summary]]",
    user_note: null,
    pdf_available: true,
    pdf_source: "unpaywall" as const,

    summary_skill: "summarizer@1.0.0",
    classifier_skill: "classifier@1.0.0",
    summary_generated_at: "2026-03-26T12:00:00Z",
    classifier_generated_at: "2026-03-26T12:05:00Z",
    tier_4: {
      study_type: "randomized_controlled_trial",
      sample_size: 80,
      duration_weeks: 8,
      population: "adults",
      control: "placebo",
      blinding: "double_blind",
      primary_outcome: "stress_score",
      outcome_direction: "positive",
      effect_size: "moderate",
      significance: "p<0.05",
      evidence_quality: "moderate",
      funding_source: null,
      conflict_of_interest: null,
    },
    tier_5: {
      herb_species: ["Withania somnifera"],
      common_names: ["ashwagandha"],
      active_compounds: [],
      plant_parts: [],
      extraction_types: [],
      dosages: [],
      adverse_events: [],
      safety_rating: "good",
    },
    tier_6_taxonomy: {
      therapeutic_areas: ["stress"],
      mechanisms: ["cortisol_modulation"],
      indications: ["stress_management"],
      contraindications: [],
      drug_interactions: [],
      research_gaps: [],
    },
    tier_7_provisional: [
      {
        group: "mechanisms",
        value: "new:hpa_axis_resilience",
        confidence: 0.72,
        proposed_by: "classifier",
        logged_at: "2026-03-26T12:05:00Z",
      },
    ],
    summary_versions: [
      "[[Research/studies/_assets/smith2023ashwagandha/summary.v1.md|v1]]",
      "[[Research/studies/_assets/smith2023ashwagandha/summary.current.md|current]]",
    ],

    user_rating: null,
    user_priority: null,
    user_status: null,
    notes: "",
  };
}

describe("StudyFrontmatterSchema", () => {
  test("parses valid v0.3 frontmatter shape", () => {
    const fixture = validFrontmatterFixture();

    const parsed = parseStudyFrontmatter(fixture);

    expect(parsed.rhizome_id).toBe(fixture.rhizome_id);
    expect(parsed.note_type).toBe("study");
    expect(parsed.pipeline_status).toBe("partial");
    expect(parsed.has_summary).toBe(true);
    expect(parsed.summary_skill).toBe("summarizer@1.0.0");
    expect(parsed.tier_4?.sample_size).toBe(80);
    expect(parsed.tier_7_provisional?.[0]?.value).toBe("new:hpa_axis_resilience");
  });

  test("safeParse rejects invalid identity and pipeline fields", () => {
    const fixture = validFrontmatterFixture();
    fixture.rhizome_id = "not-a-uuid";
    fixture.pipeline_status = "bad_status" as "partial";

    const result = safeParseStudyFrontmatter(fixture);

    expect(result.success).toBe(false);
  });

  test("safeParse rejects invalid bibliographic constraints", () => {
    const fixture = validFrontmatterFixture();
    fixture.year = 1800;
    fixture.authors = [];

    const result = safeParseStudyFrontmatter(fixture);

    expect(result.success).toBe(false);
  });

  test("safeParse rejects invalid wikilinks, user fields, and malformed classifier tier fields", () => {
    const fixture = validFrontmatterFixture();
    fixture.summary = "Research/studies/_assets/smith2023ashwagandha/summary.current.md";
    fixture.user_priority = "urgent" as "high";
    fixture.tier_4.sample_size = "eighty" as unknown as number;

    const result = safeParseStudyFrontmatter(fixture);

    expect(result.success).toBe(false);
  });

  test("safeParse rejects unknown classifier tier keys due to strict schema", () => {
    const fixture = validFrontmatterFixture();
    (fixture.tier_4 as Record<string, unknown>).unexpected = "value";

    const result = safeParseStudyFrontmatter(fixture);

    expect(result.success).toBe(false);
  });

  test("safeParse rejects removed legacy fields due to strict schema", () => {
    const legacyShape = {
      ...validFrontmatterFixture(),
      citekey: "smith2023ashwagandha",
      pipeline_steps: {},
      pipeline_overall: "complete",
      source_tags: ["legacy"],
      pdf_path: "Research/studies/_assets/smith2023ashwagandha/source.pdf",
      volume: "112",
      issue: "4",
      pages: "155-163",
    } as Record<string, unknown>;

    const result = safeParseStudyFrontmatter(legacyShape);

    expect(result.success).toBe(false);
  });

  test("type guard mirrors schema validity", () => {
    const valid = validFrontmatterFixture();
    const invalid = { ...validFrontmatterFixture(), note_type: "not-study" };

    expect(isValidStudyFrontmatter(valid)).toBe(true);
    expect(isValidStudyFrontmatter(invalid)).toBe(false);
  });
});
