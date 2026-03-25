import { describe, expect, test } from "bun:test";
import {
  isValidStudyFrontmatter,
  parseStudyFrontmatter,
  safeParseStudyFrontmatter,
} from "../frontmatter";
import {
  PipelineOverallStatus,
  PipelineStep,
  PipelineStepStatus,
} from "../../types/pipeline";

function validFrontmatterFixture() {
  return {
    siss_id: "550e8400-e29b-41d4-a716-446655440000",
    citekey: "smith2023ashwagandha",
    note_type: "study" as const,
    pipeline_overall: PipelineOverallStatus.IN_PROGRESS,
    pipeline_steps: {
      [PipelineStep.INGEST]: {
        status: PipelineStepStatus.COMPLETE,
        updated_at: "2026-03-25T17:20:00Z",
        retries: 0,
      },
      [PipelineStep.ZOTERO_SYNC]: {
        status: PipelineStepStatus.COMPLETE,
        updated_at: "2026-03-25T17:20:05Z",
        retries: 0,
      },
      [PipelineStep.FULLTEXT_DOCLING]: {
        status: PipelineStepStatus.SKIPPED,
        updated_at: "2026-03-25T17:21:10Z",
        retries: 0,
        skip_reason: "provider_disabled",
      },
    },
    pipeline_error: null,
    last_pipeline_run: "2026-03-25",
    title: "Ashwagandha root extract reduces cortisol in chronically stressed adults",
    authors: [
      { family: "Smith", given: "J" },
      { family: "Patel", given: "R" },
    ],
    year: 2023,
    journal: "Phytomedicine",
    doi: "10.1016/j.phymed.2023.01.012",
    pmid: "37291847",
    volume: "112",
    issue: "4",
    pages: "155-163",
    item_type: "journalArticle",
    zotero_key: "ABC123",
    zotero_version: 42,
    zotero_sync_status: "active" as const,
    source: "zotero",
    source_collections: ["Adaptogens", "Clinical Trials"],
    source_tags: ["ashwagandha", "cortisol"],
    date_added: "2026-03-25T17:00:00Z",
    asset_dir: "Research/studies/_assets/smith2023ashwagandha/",
    pdf_path: "Research/studies/_assets/smith2023ashwagandha/source.pdf",
    pdf_available: true,
    pdf_source: "unpaywall" as const,
    fulltext_path: "Research/studies/_assets/smith2023ashwagandha/fulltext.md",
    summary_path: "Research/studies/_assets/smith2023ashwagandha/summary.current.md",
  };
}

describe("StudyFrontmatterSchema", () => {
  test("parses valid frontmatter across tiers 0-3", () => {
    const fixture = validFrontmatterFixture();

    const parsed = parseStudyFrontmatter(fixture);

    expect(parsed.siss_id).toBe(fixture.siss_id);
    expect(parsed.note_type).toBe("study");
    expect(parsed.pipeline_steps[PipelineStep.INGEST]?.status).toBe(
      PipelineStepStatus.COMPLETE,
    );
    expect(parsed.pdf_source).toBe("unpaywall");
  });

  test("safeParse rejects invalid identity and pipeline fields", () => {
    const fixture = validFrontmatterFixture();
    fixture.siss_id = "not-a-uuid";
    fixture.pipeline_overall = "bad_status" as PipelineOverallStatus;

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

  test("safeParse rejects invalid zotero/asset fields", () => {
    const fixture = validFrontmatterFixture();
    fixture.zotero_sync_status = "invalid" as "active";
    fixture.pdf_source = "invalid" as "unpaywall";

    const result = safeParseStudyFrontmatter(fixture);

    expect(result.success).toBe(false);
  });

  test("type guard mirrors schema validity", () => {
    const valid = validFrontmatterFixture();
    const invalid = { ...validFrontmatterFixture(), note_type: "not-study" };

    expect(isValidStudyFrontmatter(valid)).toBe(true);
    expect(isValidStudyFrontmatter(invalid)).toBe(false);
  });
});
