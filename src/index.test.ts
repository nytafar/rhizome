import { describe, expect, test } from "bun:test";
import {
  PipelineOverallStatus,
  PipelineStep,
  PipelineStepStatus,
  type JobStatus,
} from "./types/pipeline";
import type { StudyRecord } from "./types/study";

describe("project scaffold", () => {
  test("bun test runner is configured", () => {
    expect(true).toBe(true);
  });
});

describe("pipeline enums", () => {
  test("exposes canonical pipeline status values", () => {
    expect(PipelineOverallStatus.NOT_STARTED).toBe(
      PipelineOverallStatus.NOT_STARTED,
    );
    expect(PipelineStep.FULLTEXT_MARKER).toBe(PipelineStep.FULLTEXT_MARKER);
    expect(PipelineStepStatus.BLOCKED).toBe(PipelineStepStatus.BLOCKED);

    const jobStatus: JobStatus = "queued";
    expect(jobStatus).toBe("queued");
  });
});

describe("study record typing", () => {
  test("allows minimal valid shape from schema spec", () => {
    const study: StudyRecord = {
      siss_id: "550e8400-e29b-41d4-a716-446655440000",
      citekey: "smith2023ashwagandha",
      title: "Ashwagandha root extract reduces cortisol",
      authors: [{ family: "Smith", given: "J" }],
      year: 2023,
      pipeline_overall: PipelineOverallStatus.NOT_STARTED,
      pipeline_steps: {
        [PipelineStep.INGEST]: {
          status: PipelineStepStatus.PENDING,
          updated_at: "2026-03-25T17:20:00Z",
          retries: 0,
        },
      },
      pdf_available: false,
      source: "zotero",
    };

    expect(study.citekey).toBe("smith2023ashwagandha");
  });
});
