import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClaudeCodeResult, invokeClaudeCode } from "../../ai/executor";
import { PipelineStep } from "../../types/pipeline";
import { ClassifyStageError, runClassifyStage, stageHandlerRegistry } from "../classify";

type InvokeStub = (
  options: Parameters<typeof invokeClaudeCode>[0],
) => Promise<ClaudeCodeResult>;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("runClassifyStage", () => {
  test("reads summary extraction, validates classifier output, and emits provisional metadata", async () => {
    const root = await makeTempDir("rhizome-classify-");
    const citekey = "smith2026classify";
    const studyAssetsDir = join(root, "_assets", citekey);
    await mkdir(studyAssetsDir, { recursive: true });

    await Bun.write(
      join(studyAssetsDir, "summary.current.md"),
      [
        "---",
        'source: "fulltext"',
        "---",
        "",
        "## Structured Extraction",
        "",
        "```json",
        "{",
        '  "herb_species": ["Withania somnifera"],',
        '  "common_names": ["ashwagandha"],',
        '  "active_compounds": [],',
        '  "plant_parts": [],',
        '  "extraction_types": [],',
        '  "dosages": [],',
        '  "adverse_events": [],',
        '  "study_type": "randomized_controlled_trial",',
        '  "sample_size": 80,',
        '  "duration": "8 weeks",',
        '  "population": "adults"',
        "}",
        "```",
        "",
      ].join("\n"),
    );

    const captured: { input?: string; systemPromptFile?: string } = {};
    const invoke: InvokeStub = async (options) => {
      captured.input = options.input;
      captured.systemPromptFile = options.systemPromptFile;

      return {
        exitCode: 0,
        stderr: "",
        durationMs: 632,
        stdout: JSON.stringify({
          source: "fulltext",
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
            },
          ],
        }),
      };
    };

    const result = await runClassifyStage({
      study: {
        citekey,
        title: "Classify study",
        doi: "10.1000/example.classify",
        pmid: "123456",
      },
      assetsRootDir: join(root, "_assets"),
      skillsDir: ".siss/skills",
      classifierSkillFile: "classifier.md",
      skillVersion: "v1",
      model: "claude-sonnet-4",
      maxTurns: 5,
      timeoutMs: 30_000,
      now: new Date("2026-03-27T02:30:00.000Z"),
      invoke,
    });

    expect(result.summaryPath).toBe(join(studyAssetsDir, "summary.current.md"));
    expect(result.metadata.stage).toBe(PipelineStep.CLASSIFY);
    expect(result.metadata.model).toBe("claude-sonnet-4");
    expect(result.metadata.provisionalCount).toBe(1);
    expect(result.metadata.generatedAt).toBe("2026-03-27T02:30:00.000Z");
    expect(result.metadata.tier_7_provisional).toEqual([
      {
        group: "mechanisms",
        value: "new:hpa_axis_resilience",
        confidence: 0.72,
      },
    ]);

    expect(captured.systemPromptFile).toBe(".siss/skills/classifier.md");
    expect(captured.input).toContain("# Structured Extraction");
    expect(captured.input).toContain("Withania somnifera");
  });

  test("fails with actionable parse error when Structured Extraction section is missing", async () => {
    const root = await makeTempDir("rhizome-classify-");
    const citekey = "smith2026missingstructured";
    const studyAssetsDir = join(root, "_assets", citekey);
    await mkdir(studyAssetsDir, { recursive: true });

    await Bun.write(
      join(studyAssetsDir, "summary.current.md"),
      "# Summary\n\nNo extraction section here.",
    );

    await expect(
      runClassifyStage({
        study: {
          citekey,
          title: "Missing extraction",
        },
        assetsRootDir: join(root, "_assets"),
        skillsDir: ".siss/skills",
        classifierSkillFile: "classifier.md",
        skillVersion: "v1",
        model: "claude",
        maxTurns: 5,
        timeoutMs: 30_000,
        invoke: async () => {
          throw new Error("invoke should not run when summary parse fails");
        },
      }),
    ).rejects.toMatchObject({
      name: "ClassifyStageError",
      errorClass: "permanent",
      code: "summary_missing_structured_extraction",
    } satisfies Partial<ClassifyStageError>);
  });

  test("fails when Structured Extraction contains malformed JSON", async () => {
    const root = await makeTempDir("rhizome-classify-");
    const citekey = "smith2026corruptstructured";
    const studyAssetsDir = join(root, "_assets", citekey);
    await mkdir(studyAssetsDir, { recursive: true });

    await Bun.write(
      join(studyAssetsDir, "summary.current.md"),
      [
        "## Structured Extraction",
        "",
        "```json",
        '{ "study_type": "rct", }',
        "```",
        "",
      ].join("\n"),
    );

    await expect(
      runClassifyStage({
        study: {
          citekey,
          title: "Malformed extraction",
        },
        assetsRootDir: join(root, "_assets"),
        skillsDir: ".siss/skills",
        classifierSkillFile: "classifier.md",
        skillVersion: "v1",
        model: "claude",
        maxTurns: 5,
        timeoutMs: 30_000,
        invoke: async () => {
          throw new Error("invoke should not run when summary parse fails");
        },
      }),
    ).rejects.toMatchObject({
      name: "ClassifyStageError",
      errorClass: "permanent",
      code: "summary_invalid_structured_extraction_json",
    } satisfies Partial<ClassifyStageError>);
  });
});

describe("stageHandlerRegistry", () => {
  test("wires classify handler under PipelineStep.CLASSIFY", () => {
    expect(stageHandlerRegistry[PipelineStep.CLASSIFY]).toBe(runClassifyStage);
  });
});
