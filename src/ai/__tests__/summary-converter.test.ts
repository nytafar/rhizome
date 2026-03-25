import { describe, expect, test } from "bun:test";
import { summaryJsonToMarkdown } from "../summary-converter";

describe("summaryJsonToMarkdown", () => {
  test("renders summarizer JSON output and metadata into markdown", () => {
    const markdown = summaryJsonToMarkdown(
      {
        source: "fulltext",
        tldr: "Ashwagandha reduced cortisol and improved sleep quality over 8 weeks.",
        background: "Chronic stress remains under-treated in working-age adults.",
        methods:
          "Double-blind RCT, n=120 adults, 600 mg/day root extract vs placebo.",
        key_findings:
          "Cortisol dropped 18% vs 3% (p<0.01), PSQI improved by 2.1 points.",
        clinical_relevance:
          "Supports a standardized root-extract option for moderate stress symptoms.",
        limitations:
          "Single center, short duration, self-reported sleep endpoint.",
        compounds_and_doses: [
          {
            compound: "Withania somnifera root extract",
            dose: "600 mg/day",
            frequency: "once daily",
            duration: "8 weeks",
          },
          {
            compound: "Withanolides",
            dose: "5% standardized",
          },
        ],
        open_questions:
          "Does efficacy persist beyond 12 weeks and in older populations?",
        structured_extraction: {
          herb_species: ["Withania somnifera"],
          common_names: ["ashwagandha"],
          active_compounds: ["withanolides"],
          plant_parts: ["root"],
          extraction_types: ["ethanolic"],
          dosages: ["600 mg/day"],
          adverse_events: ["mild GI discomfort"],
          study_type: "randomized controlled trial",
          sample_size: 120,
          duration: "8 weeks",
          population: "Adults with chronic stress",
        },
      },
      {
        citekey: "smith2023ashwagandha",
        skillVersion: "1.0",
        model: "claude-opus-4-5",
        generatedAt: "2026-03-25T17:30:00Z",
      },
    );

    expect(markdown).toMatchSnapshot();
  });

  test("renders defaults for missing optional fields", () => {
    const markdown = summaryJsonToMarkdown(
      {
        source: "abstract_only",
        tldr: "Promising signal from abstract-only evidence.",
        background: "Pilot exploration of a botanical intervention.",
        methods: "Open-label pilot with abstract-level detail only.",
        key_findings: "Directionally positive outcomes were reported.",
        clinical_relevance: "Insufficient for recommendations.",
        limitations: "Full text unavailable; high uncertainty.",
      },
      {
        citekey: "doe2024pilot",
        skillVersion: "1.1",
        model: "claude-sonnet-4",
        generatedAt: "2026-03-25T18:00:00Z",
      },
    );

    expect(markdown).toContain("source: \"abstract_only\"");
    expect(markdown).toContain("## Compounds & Doses\nNot applicable");
    expect(markdown).toContain("## Open Questions\nNone identified");
    expect(markdown).toContain("## Structured Extraction\nNot provided");
  });
});
