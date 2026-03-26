import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { parseStudyFrontmatter } from "../../schema/frontmatter";
import {
  PipelineOverallStatus,
  PipelineStep,
  PipelineStepStatus,
} from "../../types/pipeline";
import type { StudyRecord } from "../../types/study";
import { buildStudyNoteMarkdown } from "../note-builder";

function baseStudyFixture(): StudyRecord {
  return {
    siss_id: "550e8400-e29b-41d4-a716-446655440000",
    citekey: "smith2023ashwagandha",
    title: "Ashwagandha root extract reduces cortisol in chronically stressed adults",
    authors: [
      { family: "Smith", given: "J" },
      { family: "Patel", given: "R" },
    ],
    year: 2023,
    journal: "Phytomedicine",
    doi: "10.1016/j.phymed.2023.01.012",
    abstract:
      "Randomized, double-blind trial evaluating standardized ashwagandha root extract in adults with chronic stress.",
    item_type: "journalArticle",
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
      [PipelineStep.SUMMARIZE]: {
        status: PipelineStepStatus.COMPLETE,
        updated_at: "2026-03-25T17:31:00Z",
        retries: 0,
      },
      [PipelineStep.CLASSIFY]: {
        status: PipelineStepStatus.PENDING,
        updated_at: "2026-03-25T17:31:01Z",
        retries: 0,
      },
    },
    pipeline_error: null,
    last_pipeline_run: "2026-03-25",
    zotero_key: "ABC123",
    zotero_version: 42,
    zotero_sync_status: "active",
    source: "zotero",
    source_collections: ["Adaptogens", "Clinical Trials"],
    source_tags: ["ashwagandha", "cortisol"],
    date_added: "2026-03-25T17:00:00Z",
    asset_dir: "Research/studies/_assets/smith2023ashwagandha/",
    pdf_path: "Research/studies/_assets/smith2023ashwagandha/source.pdf",
    fulltext_path: "Research/studies/_assets/smith2023ashwagandha/fulltext.md",
    summary_path: "Research/studies/_assets/smith2023ashwagandha/summary.current.md",
    pdf_available: true,
    pdf_source: "unpaywall",
    summary_skill_version: "1.0",
    summary_model: "claude-opus-4-5",
    summary_generated_at: "2026-03-25T17:30:00Z",
  };
}

describe("buildStudyNoteMarkdown", () => {
  test("renders canonical study note markdown with valid frontmatter", () => {
    const markdown = buildStudyNoteMarkdown(baseStudyFixture());

    expect(markdown.trimEnd()).toMatchSnapshot();

    const parsed = matter(markdown);
    const frontmatter = parseStudyFrontmatter(parsed.data);

    expect(frontmatter.note_type).toBe("study");
    expect(frontmatter.doi).toBe("10.1016/j.phymed.2023.01.012");
    expect(frontmatter.pipeline_status).toBe("partial");
    expect(frontmatter.summary).toBe(
      "[[Research/studies/_assets/smith2023ashwagandha/summary.current.md|AI Summary]]",
    );
  });

  test("gracefully handles missing optional fulltext, summary, and classifier metadata", () => {
    const study = baseStudyFixture();
    delete study.abstract;
    delete study.fulltext_path;
    delete study.summary_path;
    delete study.classifier_generated_at;
    delete study.classifier_model;
    delete study.classifier_skill_version;

    const markdown = buildStudyNoteMarkdown(study);

    expect(markdown).toContain("> Abstract unavailable.");
    expect(markdown).toContain("## TL;DR\n_Summary not available yet._");
    expect(markdown).toContain("## Key Findings\n_Summary not available yet._");
    expect(markdown).toContain("| — | classify | — |");
    expect(markdown).toContain("## Links");

    const parsed = matter(markdown);
    expect(() => parseStudyFrontmatter(parsed.data)).not.toThrow();
  });
});
