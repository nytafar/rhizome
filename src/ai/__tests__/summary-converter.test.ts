import { describe, expect, test } from "bun:test";
import { summaryJsonToMarkdown } from "../summary-converter";

describe("summaryJsonToMarkdown", () => {
  test("converts summarizer JSON and metadata into canonical summary markdown", () => {
    const markdown = summaryJsonToMarkdown(
      {
        source: "fulltext",
        tldr: "Curcumin improved pain and function over placebo in 12 weeks.",
        background: "The study assessed curcumin for osteoarthritis symptom relief.",
        methods:
          "Double-blind RCT in adults with knee OA, 500mg curcumin BID vs placebo for 12 weeks.",
        key_findings:
          "Pain scores decreased by 24% vs 9% placebo (p=0.01). No severe adverse events reported.",
        clinical_relevance:
          "Standardized curcumin may be useful as adjunctive care for mild-to-moderate OA symptoms.",
        limitations:
          "Single-center trial and short follow-up limit long-term generalizability.",
        compounds_and_doses: [
          {
            compound: "Curcumin",
            dose: "500 mg",
            frequency: "twice daily",
            duration: "12 weeks",
          },
          {
            compound: "Piperine",
            dose: "5 mg",
          },
        ],
        open_questions:
          "Whether effects persist beyond 12 weeks and in multi-center populations.",
        structured_extraction: {
          herb_species: ["Curcuma longa"],
          common_names: ["turmeric"],
          active_compounds: ["curcumin", "demethoxycurcumin"],
          plant_parts: ["rhizome"],
          extraction_types: ["ethanolic"],
          dosages: ["500 mg BID"],
          adverse_events: ["mild GI discomfort"],
          study_type: "RCT",
          sample_size: 84,
          duration: "12 weeks",
          population: "Adults with knee osteoarthritis",
        },
      },
      {
        citekey: "doe2024curcumin",
        skillVersion: "1.1",
        model: "claude-opus-4-5",
        generatedAt: "2026-03-25T22:30:00Z",
      },
    );

    expect(markdown.trimEnd()).toMatchSnapshot();
  });

  test("falls back for optional sections when data is missing", () => {
    const markdown = summaryJsonToMarkdown(
      {
        source: "abstract_only",
        tldr: "Findings are promising but limited to abstract-level detail.",
        background: "Investigated botanical intervention in stress symptoms.",
        methods: "Abstract-reported trial details were sparse.",
        key_findings: "Reported symptom improvements without full quantitative data.",
        clinical_relevance: "Potential signal for future controlled studies.",
        limitations: "No full text available; extraction confidence is reduced.",
      },
      {
        citekey: "smith2025botanical",
        skillVersion: "1.1",
        model: "claude-sonnet-4",
        generatedAt: "2026-03-25T22:35:00Z",
      },
    );

    expect(markdown).toContain("source: \"abstract_only\"");
    expect(markdown).toContain("## Compounds & Doses\nNot applicable");
    expect(markdown).toContain("## Open Questions\nNone identified");
    expect(markdown).toContain("## Structured Extraction\nNot provided");
  });
});
