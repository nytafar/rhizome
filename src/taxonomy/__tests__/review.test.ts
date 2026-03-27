import { describe, expect, test } from "bun:test";
import { createEmptyTaxonomyState } from "../schema";
import { buildTaxonomyReviewProposals, renderTaxonomyReviewMarkdown } from "../review";
import type { TaxonomyDocument } from "../types";

function makeState(): TaxonomyDocument {
  const state = createEmptyTaxonomyState([
    "therapeutic_areas",
    "mechanisms",
    "indications",
    "contraindications",
    "drug_interactions",
    "research_gaps",
  ]);

  state.groups.mechanisms.values.cortisol_modulation = {
    count: 3,
    last_used_at: "2026-03-27T00:00:00.000Z",
    aliases: [],
    created_at: "2026-03-26T00:00:00.000Z",
  };

  state.groups.mechanisms.pending.cortisol = {
    count: 2,
    first_seen_at: "2026-03-27T01:00:00.000Z",
    last_seen_at: "2026-03-27T02:00:00.000Z",
    sources: ["classifier"],
  };

  state.groups.therapeutic_areas.pending.stress_resilience = {
    count: 1,
    first_seen_at: "2026-03-27T01:00:00.000Z",
    last_seen_at: "2026-03-27T03:00:00.000Z",
    sources: ["classifier", "manual"],
  };

  return state;
}

describe("taxonomy review proposal builder", () => {
  test("builds deterministic proposal ids and operations from pending state", () => {
    const state = makeState();

    const proposals = buildTaxonomyReviewProposals(state);

    expect(proposals.map((proposal) => proposal.proposal_id)).toEqual([
      "proposal:mechanisms:merge:cortisol",
      "proposal:therapeutic_areas:rename:stress_resilience",
    ]);

    expect(proposals[0]).toMatchObject({
      group_name: "mechanisms",
      operation_type: "merge",
      source_value: "cortisol",
      target_value: "cortisol_modulation",
      pending_count: 2,
    });

    expect(proposals[1]).toMatchObject({
      group_name: "therapeutic_areas",
      operation_type: "rename",
      source_value: "stress_resilience",
      target_value: "stress_resilience",
      pending_count: 1,
    });
  });

  test("renders deterministic scaffold when no proposals exist", () => {
    const state = createEmptyTaxonomyState([
      "therapeutic_areas",
      "mechanisms",
      "indications",
      "contraindications",
      "drug_interactions",
      "research_gaps",
    ]);

    const proposals = buildTaxonomyReviewProposals(state);
    const markdown = renderTaxonomyReviewMarkdown({
      generatedAt: "2026-03-27T00:00:00.000Z",
      proposals,
    });

    expect(proposals).toEqual([]);
    expect(markdown).toContain("# Taxonomy Review");
    expect(markdown).toContain("Generated at: 2026-03-27T00:00:00.000Z");
    expect(markdown).toContain("| _none_ | - | - | - | - | 0 | - | - |");
  });

  test("sanitizes proposal id source segment for malformed source values", () => {
    const state = createEmptyTaxonomyState([
      "therapeutic_areas",
      "mechanisms",
      "indications",
      "contraindications",
      "drug_interactions",
      "research_gaps",
    ]);

    state.groups.research_gaps.pending["Gap: Needs RCT"] = {
      count: 1,
      first_seen_at: "2026-03-27T00:00:00.000Z",
      last_seen_at: "2026-03-27T00:00:00.000Z",
      sources: ["classifier"],
    };

    const proposals = buildTaxonomyReviewProposals(state);
    expect(proposals[0]?.proposal_id).toBe("proposal:research_gaps:rename:gap_needs_rct");
  });
});
