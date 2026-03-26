import { afterEach, describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../db/database";
import { parseStudyFrontmatter } from "../../schema/frontmatter";
import {
  PipelineOverallStatus,
  PipelineStep,
  PipelineStepStatus,
} from "../../types/pipeline";
import type { StudyRecord } from "../../types/study";
import { runVaultWriteStage, stageHandlerRegistry } from "../vault-write";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function buildStudyFixture(): StudyRecord {
  return {
    siss_id: "550e8400-e29b-41d4-a716-446655440000",
    rhizome_id: "550e8400-e29b-41d4-a716-446655440000",
    citekey: "smith2023ashwagandha",
    title: "Ashwagandha root extract reduces cortisol in chronically stressed adults",
    authors: [
      { family: "Smith", given: "J" },
      { family: "Patel", given: "R" },
    ],
    year: 2023,
    abstract:
      "Randomized, double-blind trial evaluating standardized ashwagandha root extract in adults with chronic stress.",
    pipeline_overall: PipelineOverallStatus.IN_PROGRESS,
    pipeline_steps: {
      [PipelineStep.INGEST]: {
        status: PipelineStepStatus.COMPLETE,
        updated_at: "2026-03-25T17:20:00Z",
        retries: 0,
      },
      [PipelineStep.SUMMARIZE]: {
        status: PipelineStepStatus.COMPLETE,
        updated_at: "2026-03-25T17:31:00Z",
        retries: 0,
      },
    },
    pipeline_error: null,
    last_pipeline_run: "2026-03-25",
    source: "zotero",
    pdf_available: false,
  };
}

const VAULT_CONFIG = {
  research_root: "Research",
  studies_folder: "studies",
  assets_folder: "_assets",
} as const;

describe("runVaultWriteStage", () => {
  test("writes study note, validates frontmatter, creates asset dir, updates pipeline step, and logs stage", async () => {
    const root = await makeTempDir("rhizome-vault-write-");
    const dbPath = join(root, "rhizome.sqlite");

    const database = new Database({ path: dbPath });
    database.init();

    const study = buildStudyFixture();

    database.db
      .query(
        `
        INSERT INTO studies (rhizome_id, citekey, source, title, pipeline_overall, pipeline_steps_json)
        VALUES (?, ?, ?, ?, ?, ?);
        `,
      )
      .run(
        study.rhizome_id,
        study.citekey,
        study.source,
        study.title,
        study.pipeline_overall,
        JSON.stringify(study.pipeline_steps),
      );

    const result = await runVaultWriteStage({
      db: database.db,
      study,
      vaultPath: root,
      vault: VAULT_CONFIG,
      now: () => new Date("2026-03-25T22:50:00.000Z"),
    });

    expect(result.notePath).toBe(join(root, "Research", "studies", "smith2023ashwagandha.md"));
    expect(result.assetDirPath).toBe(
      join(root, "Research", "studies", "_assets", "smith2023ashwagandha"),
    );
    expect(result.metadata.stage).toBe(PipelineStep.VAULT_WRITE);
    expect(result.metadata.frontmatterValid).toBe(true);

    const parsedMatter = matter(await readFile(result.notePath, "utf8"));
    const frontmatter = parseStudyFrontmatter(parsedMatter.data);

    expect(frontmatter.note_type).toBe("study");
    expect(frontmatter.rhizome_id).toBe(study.rhizome_id);
    expect(frontmatter.pipeline_status).toBe("partial");
    expect(frontmatter.has_summary).toBe(false);
    expect(frontmatter.pdf_available).toBe(false);

    const assetDirStat = await stat(result.assetDirPath);
    expect(assetDirStat.isDirectory()).toBe(true);

    const dbStudyRow = database.db
      .query(
        "SELECT pipeline_steps_json FROM studies WHERE rhizome_id = ? LIMIT 1;",
      )
      .get(study.rhizome_id) as { pipeline_steps_json: string };

    const pipelineSteps = JSON.parse(dbStudyRow.pipeline_steps_json) as Record<
      string,
      { status?: string }
    >;
    expect(pipelineSteps[PipelineStep.VAULT_WRITE]?.status).toBe("complete");

    const stageLog = database.db
      .query(
        `
        SELECT stage, status, metadata
        FROM job_stage_log
        WHERE rhizome_id = ?
        ORDER BY id DESC
        LIMIT 1;
        `,
      )
      .get(study.rhizome_id) as { stage: string; status: string; metadata: string };

    expect(stageLog.stage).toBe(PipelineStep.VAULT_WRITE);
    expect(stageLog.status).toBe("completed");

    const metadata = JSON.parse(stageLog.metadata) as {
      note_path: string;
      asset_dir: string;
      frontmatter_valid: boolean;
    };

    expect(metadata.note_path).toBe("Research/studies/smith2023ashwagandha.md");
    expect(metadata.asset_dir).toBe("Research/studies/_assets/smith2023ashwagandha/");
    expect(metadata.frontmatter_valid).toBe(true);

    database.close();
  });

  test("overwrites an existing note when vault_write reruns", async () => {
    const root = await makeTempDir("rhizome-vault-write-");
    const dbPath = join(root, "rhizome.sqlite");

    const database = new Database({ path: dbPath });
    database.init();

    const study = buildStudyFixture();

    database.db
      .query(
        `
        INSERT INTO studies (rhizome_id, citekey, source, title, pipeline_overall, pipeline_steps_json)
        VALUES (?, ?, ?, ?, ?, ?);
        `,
      )
      .run(
        study.rhizome_id,
        study.citekey,
        study.source,
        study.title,
        study.pipeline_overall,
        JSON.stringify(study.pipeline_steps),
      );

    const notePath = join(root, "Research", "studies", "smith2023ashwagandha.md");
    await Bun.write(notePath, "legacy-content");

    const updatedStudy: StudyRecord = {
      ...study,
      title: "Updated title for overwrite verification",
    };

    await runVaultWriteStage({
      db: database.db,
      study: updatedStudy,
      vaultPath: root,
      vault: VAULT_CONFIG,
      now: () => new Date("2026-03-25T22:55:00.000Z"),
    });

    const written = await readFile(notePath, "utf8");
    expect(written).toContain("# Updated title for overwrite verification");
    expect(written).not.toContain("legacy-content");

    database.close();
  });
  test("preserves user-managed frontmatter fields when existing frontmatter is provided", async () => {
    const root = await makeTempDir("rhizome-vault-write-");
    const dbPath = join(root, "rhizome.sqlite");

    const database = new Database({ path: dbPath });
    database.init();

    const study = buildStudyFixture();

    database.db
      .query(
        `
        INSERT INTO studies (rhizome_id, citekey, source, title, pipeline_overall, pipeline_steps_json)
        VALUES (?, ?, ?, ?, ?, ?);
        `,
      )
      .run(
        study.rhizome_id,
        study.citekey,
        study.source,
        study.title,
        study.pipeline_overall,
        JSON.stringify(study.pipeline_steps),
      );

    const result = await runVaultWriteStage({
      db: database.db,
      study,
      existingFrontmatter: {
        tags: ["manual-tag"],
        user_rating: 4,
        user_status: "reading",
        notes: "keep me",
      },
      vaultPath: root,
      vault: VAULT_CONFIG,
      now: () => new Date("2026-03-25T22:56:00.000Z"),
    });

    const parsedMatter = matter(await readFile(result.notePath, "utf8"));
    const frontmatter = parseStudyFrontmatter(parsedMatter.data);

    expect(frontmatter.tags).toEqual(["manual-tag"]);
    expect(frontmatter.user_rating).toBe(4);
    expect(frontmatter.user_status).toBe("reading");
    expect(frontmatter.notes).toBe("keep me");

    database.close();
  });
});

describe("stageHandlerRegistry", () => {
  test("wires vault_write handler under PipelineStep.VAULT_WRITE", () => {
    expect(stageHandlerRegistry[PipelineStep.VAULT_WRITE]).toBe(runVaultWriteStage);
  });
});
