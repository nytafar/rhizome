import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { parseStudyFrontmatter } from "../../schema/frontmatter";
import {
  PipelineOverallStatus,
  PipelineStep,
  PipelineStepStatus,
} from "../../types/pipeline";
import type { StudyRecord } from "../../types/study";
import { buildStudyNoteMarkdown, mergeFrontmatterProjection } from "../note-builder";

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

  test("preserves user-managed frontmatter fields and write-once tags when existing frontmatter is provided", () => {
    const study = baseStudyFixture();

    const markdown = buildStudyNoteMarkdown(study, {
      tags: ["user-tag", "keep-this"],
      user_rating: 5,
      user_priority: "high",
      user_status: "reading",
      user_note: "[[Research/study-notes/smith2023ashwagandha.note|My Notes]]",
      notes: "User annotations",
    });

    const parsed = matter(markdown);
    const frontmatter = parseStudyFrontmatter(parsed.data);

    expect(frontmatter.tags).toEqual(["user-tag", "keep-this"]);
    expect(frontmatter.user_rating).toBe(5);
    expect(frontmatter.user_priority).toBe("high");
    expect(frontmatter.user_status).toBe("reading");
    expect(frontmatter.user_note).toBe("[[Research/study-notes/smith2023ashwagandha.note|My Notes]]");
    expect(frontmatter.notes).toBe("User annotations");
  });

  test("mergeFrontmatterProjection keeps machine fields while preserving user-owned keys", () => {
    const merged = mergeFrontmatterProjection({
      machine: {
        note_type: "study",
        has_pdf: false,
        has_fulltext: false,
        has_summary: false,
        has_classification: false,
        pipeline_status: "pending",
        title: "Machine title",
        authors: [{ family: "Machine", given: "Author" }],
        year: 2024,
        pdf_available: false,
      },
      existing: {
        tags: ["my-tag"],
        user_priority: "low",
      },
    });

    expect(merged.tags).toEqual(["my-tag"]);
    expect(merged.user_priority).toBe("low");
    expect(merged.title).toBe("Machine title");
    expect(merged.pipeline_status).toBe("pending");
  });

  test("projects summary_versions with archived versions in ascending order and current last", () => {
    const study = baseStudyFixture();
    study.summary_versions = [
      "Research/studies/_assets/smith2023ashwagandha/summary.v2.md",
      "Research/studies/_assets/smith2023ashwagandha/not-a-summary.md",
      "Research/studies/_assets/smith2023ashwagandha/summary.v1.md",
      "",
      "Research/studies/_assets/smith2023ashwagandha/summary.current.md",
      "Research/studies/_assets/smith2023ashwagandha/summary.vx.md",
    ];

    const markdown = buildStudyNoteMarkdown(study);
    const parsed = matter(markdown);
    const frontmatter = parseStudyFrontmatter(parsed.data);

    expect(frontmatter.summary_versions).toEqual([
      "[[Research/studies/_assets/smith2023ashwagandha/summary.v1.md|v1]]",
      "[[Research/studies/_assets/smith2023ashwagandha/summary.v2.md|v2]]",
      "[[Research/studies/_assets/smith2023ashwagandha/summary.current.md|current]]",
    ]);
  });

  test("falls back to current-only summary_versions when no archive versions are supplied", () => {
    const study = baseStudyFixture();
    delete study.summary_versions;

    const markdown = buildStudyNoteMarkdown(study);
    const parsed = matter(markdown);
    const frontmatter = parseStudyFrontmatter(parsed.data);

    expect(frontmatter.summary_versions).toEqual([
      "[[Research/studies/_assets/smith2023ashwagandha/summary.current.md|current]]",
    ]);
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
