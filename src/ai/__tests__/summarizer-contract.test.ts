import { describe, expect, test } from "bun:test";
import { buildSummarizerInput } from "../input-builder";
import { summarizerJsonSchema } from "../schemas/summarizer";

describe("summarizer contract", () => {
  test("schema exposes required fields and is JSON-serializable", () => {
    const serialized = JSON.stringify(summarizerJsonSchema);
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
      "tldr",
      "background",
      "methods",
      "key_findings",
      "clinical_relevance",
      "limitations",
    ]);
    expect(Object.keys(parsed.properties)).toContain("structured_extraction");
  });

  test("buildSummarizerInput combines metadata and abstract into markdown", () => {
    const markdown = buildSummarizerInput({
      title: "Curcumin for knee osteoarthritis",
      authors: [
        { given: "Jane", family: "Doe" },
        { given: "John", family: "Smith" },
      ],
      year: 2024,
      journal: "Journal of Nutraceutical Research",
      doi: "10.1000/example-doi",
      pmid: "12345678",
      item_type: "clinical_trial",
      abstract: "Randomized trial showed reduced pain scores after 12 weeks.",
    });

    expect(markdown).toContain("# Study Metadata");
    expect(markdown).toContain("Title: Curcumin for knee osteoarthritis");
    expect(markdown).toContain("Authors: Jane Doe, John Smith");
    expect(markdown).toContain("Year: 2024");
    expect(markdown).toContain("Journal: Journal of Nutraceutical Research");
    expect(markdown).toContain("DOI: 10.1000/example-doi");
    expect(markdown).toContain("PMID: 12345678");
    expect(markdown).toContain("Study Type: clinical_trial");
    expect(markdown).toContain("# Abstract");
    expect(markdown).toContain(
      "Randomized trial showed reduced pain scores after 12 weeks.",
    );
  });
});
