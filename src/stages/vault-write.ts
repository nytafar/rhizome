import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import type { Database as BunSQLiteDatabase } from "bun:sqlite";
import { parseStudyFrontmatter, type StudyFrontmatter } from "../schema/frontmatter";
import {
  PipelineStep,
  PipelineStepStatus,
  type PipelineStepState,
} from "../types/pipeline";
import type { StudyRecord } from "../types/study";
import { buildStudyNoteMarkdown } from "../vault/note-builder";

interface VaultPathsConfig {
  research_root: string;
  studies_folder: string;
  assets_folder: string;
}

export interface VaultWriteStageInput {
  db: BunSQLiteDatabase;
  study: StudyRecord;
  vaultPath: string;
  vault: VaultPathsConfig;
  now?: () => Date;
}

export interface VaultWriteStageResult {
  notePath: string;
  notePathRelative: string;
  assetDirPath: string;
  assetDirRelative: string;
  markdown: string;
  frontmatter: StudyFrontmatter;
  metadata: {
    stage: PipelineStep.VAULT_WRITE;
    durationMs: number;
    frontmatterValid: true;
  };
}

function normalizeAssetDirRelative(params: {
  study: StudyRecord;
  studiesDirRelative: string;
  assetsFolder: string;
}): string {
  const fromStudy = params.study.asset_dir?.trim();

  if (fromStudy) {
    return fromStudy.replace(/\/$/, "");
  }

  return join(params.studiesDirRelative, params.assetsFolder, params.study.citekey);
}

function withVaultWriteStep(study: StudyRecord, updatedAt: string): StudyRecord {
  const currentStep = study.pipeline_steps[PipelineStep.VAULT_WRITE];

  const nextStep: PipelineStepState = {
    status: PipelineStepStatus.COMPLETE,
    updated_at: updatedAt,
    retries: currentStep?.retries ?? 0,
  };

  return {
    ...study,
    pipeline_steps: {
      ...study.pipeline_steps,
      [PipelineStep.VAULT_WRITE]: nextStep,
    },
  };
}

function resolveStudyIdentity(study: StudyRecord): string {
  return (study as StudyRecord & { rhizome_id?: string }).rhizome_id ?? study.siss_id;
}

function upsertPipelineStepInDb(params: {
  db: BunSQLiteDatabase;
  rhizomeId: string;
  pipelineSteps: StudyRecord["pipeline_steps"];
  updatedAt: string;
}): void {
  params.db
    .query(
      `
      UPDATE studies
      SET pipeline_steps_json = ?, updated_at = ?
      WHERE rhizome_id = ?;
      `,
    )
    .run(JSON.stringify(params.pipelineSteps), params.updatedAt, params.rhizomeId);
}

function insertJobStageLog(params: {
  db: BunSQLiteDatabase;
  rhizomeId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  metadata: Record<string, unknown>;
}): void {
  params.db
    .query(
      `
      INSERT INTO job_stage_log (rhizome_id, stage, status, started_at, completed_at, duration_ms, metadata)
      VALUES (?, ?, 'completed', ?, ?, ?, ?);
      `,
    )
    .run(
      params.rhizomeId,
      PipelineStep.VAULT_WRITE,
      params.startedAt,
      params.completedAt,
      params.durationMs,
      JSON.stringify(params.metadata),
    );
}

export async function runVaultWriteStage(
  input: VaultWriteStageInput,
): Promise<VaultWriteStageResult> {
  const now = input.now ?? (() => new Date());

  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();

  const studiesDirRelative = join(input.vault.research_root, input.vault.studies_folder);
  const notePathRelative = join(studiesDirRelative, `${input.study.citekey}.md`);
  const assetDirRelative = normalizeAssetDirRelative({
    study: input.study,
    studiesDirRelative,
    assetsFolder: input.vault.assets_folder,
  });

  const notePath = join(input.vaultPath, notePathRelative);
  const assetDirPath = join(input.vaultPath, assetDirRelative);

  await mkdir(join(input.vaultPath, studiesDirRelative), { recursive: true });
  await mkdir(assetDirPath, { recursive: true });

  const stepUpdatedAt = now().toISOString();
  const studyWithVaultStep = withVaultWriteStep(input.study, stepUpdatedAt);
  const studyWithAssetDir: StudyRecord = {
    ...studyWithVaultStep,
    asset_dir: `${assetDirRelative}/`,
  };

  const markdown = buildStudyNoteMarkdown(studyWithAssetDir);
  const parsedMatter = matter(markdown);
  const frontmatter = parseStudyFrontmatter(parsedMatter.data);

  await Bun.write(notePath, markdown);

  const completedAtDate = now();
  const completedAt = completedAtDate.toISOString();
  const durationMs = Math.max(0, completedAtDate.getTime() - startedAtDate.getTime());

  upsertPipelineStepInDb({
    db: input.db,
    rhizomeId: input.study.rhizome_id,
    pipelineSteps: studyWithAssetDir.pipeline_steps,
    updatedAt: completedAt,
  });

  insertJobStageLog({
    db: input.db,
    rhizomeId: input.study.rhizome_id,
    startedAt,
    completedAt,
    durationMs,
    metadata: {
      note_path: notePathRelative,
      asset_dir: `${assetDirRelative}/`,
      frontmatter_valid: true,
    },
  });

  return {
    notePath,
    notePathRelative,
    assetDirPath,
    assetDirRelative: `${assetDirRelative}/`,
    markdown,
    frontmatter,
    metadata: {
      stage: PipelineStep.VAULT_WRITE,
      durationMs,
      frontmatterValid: true,
    },
  };
}

export type VaultWriteStageHandler = (
  input: VaultWriteStageInput,
) => Promise<VaultWriteStageResult>;

export const stageHandlerRegistry: Partial<Record<PipelineStep, VaultWriteStageHandler>> = {
  [PipelineStep.VAULT_WRITE]: runVaultWriteStage,
};
