import { describe, expect, test } from "bun:test";
import {
  classifierJsonSchema,
  classifierTaxonomyGroups,
  parseClassifierOutput,
  parseClassifierStdout,
  type ClassifierOutput,
} from "../schemas/classifier";

function validClassifierOutput(): ClassifierOutput {
  return {
    source: "fulltext",
    tier_4: {
      study_type: "randomized_controlled_trial",
      sample_size: 120,
      duration_weeks: 12,
      population: "Adults with mild knee osteoarthritis",
      control: "placebo",
      blinding: "double_blind",
      primary_outcome: "pain_score_reduction",
      outcome_direction: "positive",
      effect_size: "SMD -0.42",
      significance: "p<0.05",
      evidence_quality: "moderate",
      funding_source: "independent",
      conflict_of_interest: false,
    },
    tier_5: {
      herb_species: ["curcuma_longa"],
      common_names: ["turmeric"],
      active_compounds: ["curcumin"],
      plant_parts: ["rhizome"],
      extraction_types: ["standardized_extract"],
      dosages: ["500mg_bid"],
      adverse_events: ["mild_gi_discomfort"],
      safety_rating: "good",
    },
    tier_6_taxonomy: {
      therapeutic_areas: ["joint_health"],
      mechanisms: ["anti_inflammatory"],
      indications: ["knee_osteoarthritis"],
      contraindications: [],
      drug_interactions: ["anticoagulants"],
      research_gaps: ["long_term_outcomes"],
    },
    tier_7_provisional: [],
  };
}

describe("classifier contract", () => {
  test("schema exposes strict required top-level keys and is JSON-serializable", () => {
    const serialized = JSON.stringify(classifierJsonSchema);
    const parsed = JSON.parse(serialized) as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };

    expect(parsed.type).toBe("object");
    expect(parsed.additionalProperties).toBe(false);
    expect(parsed.required).toEqual([
      "source",
      "tier_4",
      "tier_5",
      "tier_6_taxonomy",
      "tier_7_provisional",
    ]);
    expect(Object.keys(parsed.properties)).toContain("tier_7_provisional");
  });

  test("accepts valid payload with zero provisional values", () => {
    const payload = validClassifierOutput();
    expect(parseClassifierOutput(payload)).toEqual(payload);
  });

  test("accepts provisional candidates using explicit new: format", () => {
    const payload = validClassifierOutput();
    payload.tier_7_provisional = [
      {
        group: "mechanisms",
        value: "new:redox_signaling_modulation",
        confidence: 0.63,
      },
    ];

    expect(parseClassifierOutput(payload).tier_7_provisional).toHaveLength(1);
  });

  test("rejects missing required tier fields", () => {
    const payload = validClassifierOutput() as Record<string, unknown>;
    delete payload.tier_4;

    expect(() => parseClassifierOutput(payload)).toThrow();
  });

  test("rejects wrong enum values in fixed tier output", () => {
    const payload = validClassifierOutput();
    payload.tier_4.evidence_quality = "very_high" as never;

    expect(() => parseClassifierOutput(payload)).toThrow();
  });

  test("rejects non-array provisional values", () => {
    const payload = {
      ...validClassifierOutput(),
      tier_7_provisional: "new:neurovascular_remodeling",
    };

    expect(() => parseClassifierOutput(payload)).toThrow();
  });

  test("rejects schema-violating provisional values without new: prefix", () => {
    const payload = validClassifierOutput();
    payload.tier_7_provisional = [
      {
        group: "therapeutic_areas",
        value: "neuroprotection",
        confidence: 0.51,
      },
    ];

    expect(() => parseClassifierOutput(payload)).toThrow();
  });

  test("rejects empty model output and invalid JSON", () => {
    expect(() => parseClassifierStdout("")).toThrow("Classifier output must be valid JSON");
    expect(() => parseClassifierStdout("not json")).toThrow("Classifier output must be valid JSON");
  });

  test("enforces provisional candidate upper bound", () => {
    const payload = validClassifierOutput();
    payload.tier_7_provisional = Array.from({ length: 101 }, (_, idx) => ({
      group: classifierTaxonomyGroups[idx % classifierTaxonomyGroups.length],
      value: `new:candidate_${idx + 1}`,
      confidence: 0.5,
    }));

    expect(() => parseClassifierOutput(payload)).toThrow();
  });
});
