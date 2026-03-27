import matter from "gray-matter";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Database as BunSQLiteDatabase } from "bun:sqlite";
import { safeParseStudyFrontmatter } from "../schema/frontmatter";
import {
  taxonomyCheckpointCursorSchema,
  taxonomyOperationTypeSchema,
  taxonomyPropagationCheckpointRecordSchema,
  taxonomyProposalDecisionRecordSchema,
} from "./schema";
import type {
  TaxonomyCheckpointCursor,
  TaxonomyPropagationCheckpointRecord,
  TaxonomyProposalDecisionRecord,
} from "./types";
import { TaxonomyManager } from "./manager";

export interface TaxonomyApplyOptions {
  resume?: boolean;
  now?: () => Date;
  batchSize?: number;
  beforeNoteRewrite?: (params: {
    decision: TaxonomyProposalDecisionRecord;
    notePath: string;
    noteIndex: number;
  }) => Promise<void> | void;
}

export interface TaxonomyApplyDecisionResult {
  proposalId: string;
  status: "completed" | "skipped";
  processedNotes: number;
  totalNotes: number;
}

export interface TaxonomyApplyResult {
  decisions: TaxonomyApplyDecisionResult[];
}

function checkpointIdForProposal(proposalId: string): string {
  return `checkpoint:${proposalId}`;
}

function normalizeTrimmed(value: string): string {
  return value.trim();
}

function normalizePendingValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("new:")) {
    return trimmed.slice(4).trim();
  }

  return trimmed;
}

function mergeUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of values) {
    const normalized = normalizeTrimmed(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }

  return merged;
}

async function listStudyNotes(vaultPath: string, researchRoot: string): Promise<string[]> {
  const studiesRoot = join(vaultPath, researchRoot, "studies");

  async function visit(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "_assets") {
          continue;
        }
        files.push(...(await visit(fullPath)));
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }

    return files;
  }

  const allFiles = await visit(studiesRoot);
  allFiles.sort((a, b) => a.localeCompare(b));
  return allFiles;
}

function readCheckpointRow(db: BunSQLiteDatabase, checkpointId: string): TaxonomyPropagationCheckpointRecord | null {
  const row = db
    .query(
      `
      SELECT
        checkpoint_id,
        proposal_id,
        status,
        cursor_json,
        processed_notes,
        total_notes,
        started_at,
        updated_at,
        completed_at,
        last_error
      FROM taxonomy_propagation_checkpoints
      WHERE checkpoint_id = ?
      LIMIT 1;
      `,
    )
    .get(checkpointId) as
    | {
        checkpoint_id: string;
        proposal_id: string;
        status: "in_progress" | "completed" | "error";
        cursor_json: string;
        processed_notes: number;
        total_notes: number;
        started_at: string;
        updated_at: string;
        completed_at: string | null;
        last_error: string | null;
      }
    | null;

  if (!row) {
    return null;
  }

  const parsedCursor = JSON.parse(row.cursor_json) as unknown;
  const cursor = taxonomyCheckpointCursorSchema.parse(parsedCursor);

  return taxonomyPropagationCheckpointRecordSchema.parse({
    checkpoint_id: row.checkpoint_id,
    proposal_id: row.proposal_id,
    status: row.status,
    cursor,
    processed_notes: row.processed_notes,
    total_notes: row.total_notes,
    started_at: row.started_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? undefined,
    last_error: row.last_error ?? undefined,
  });
}

function persistCheckpoint(db: BunSQLiteDatabase, checkpoint: TaxonomyPropagationCheckpointRecord): void {
  const validation = taxonomyPropagationCheckpointRecordSchema.parse(checkpoint);
  const cursorJson = JSON.stringify(validation.cursor);

  db.exec("BEGIN IMMEDIATE TRANSACTION;");
  try {
    db
      .query(
        `
        INSERT INTO taxonomy_propagation_checkpoints (
          checkpoint_id,
          proposal_id,
          status,
          cursor_json,
          processed_notes,
          total_notes,
          started_at,
          updated_at,
          completed_at,
          last_error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(checkpoint_id)
        DO UPDATE SET
          proposal_id = excluded.proposal_id,
          status = excluded.status,
          cursor_json = excluded.cursor_json,
          processed_notes = excluded.processed_notes,
          total_notes = excluded.total_notes,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          last_error = excluded.last_error;
        `,
      )
      .run(
        validation.checkpoint_id,
        validation.proposal_id,
        validation.status,
        cursorJson,
        validation.processed_notes,
        validation.total_notes,
        validation.started_at,
        validation.updated_at,
        validation.completed_at ?? null,
        validation.last_error ?? null,
      );

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function buildApplicableNoteList(params: {
  notePaths: string[];
  decision: TaxonomyProposalDecisionRecord;
}): Promise<string[]> {
  const { notePaths, decision } = params;

  return Promise.all(
    notePaths.map(async (notePath) => {
      const raw = await Bun.file(notePath).text();
      const parsed = matter(raw);
      const validation = safeParseStudyFrontmatter(parsed.data);
      if (!validation.success) {
        return notePath;
      }

      const frontmatter = validation.data;
      const tier6 = frontmatter.tier_6_taxonomy;
      const currentValues = tier6?.[decision.group_name] ?? [];
      const normalizedSource = normalizeTrimmed(decision.source_value);
      const hasTier6Source = currentValues.some((value) => normalizeTrimmed(value) === normalizedSource);

      const provisional = frontmatter.tier_7_provisional ?? [];
      const hasProvisionalSource = provisional.some((candidate) => {
        return (
          candidate.group === decision.group_name
          && normalizePendingValue(candidate.value) === normalizedSource
        );
      });

      return hasTier6Source || hasProvisionalSource ? notePath : null;
    }),
  ).then((paths) => paths.filter((path): path is string => path !== null));
}

async function rewriteNoteForDecision(params: {
  notePath: string;
  decision: TaxonomyProposalDecisionRecord;
}): Promise<boolean> {
  const raw = await Bun.file(params.notePath).text();
  const parsed = matter(raw);
  const validation = safeParseStudyFrontmatter(parsed.data);
  if (!validation.success) {
    throw new Error(`Malformed frontmatter in ${params.notePath}: ${validation.error.message}`);
  }

  const frontmatter = validation.data;
  const normalizedSource = normalizeTrimmed(params.decision.source_value);
  const normalizedTarget = normalizeTrimmed(params.decision.target_value);

  const nextFrontmatter = {
    ...frontmatter,
    tier_6_taxonomy: frontmatter.tier_6_taxonomy
      ? {
          ...frontmatter.tier_6_taxonomy,
          [params.decision.group_name]: mergeUnique(
            frontmatter.tier_6_taxonomy[params.decision.group_name].map((value) =>
              normalizeTrimmed(value) === normalizedSource ? normalizedTarget : normalizeTrimmed(value),
            ),
          ),
        }
      : undefined,
    tier_7_provisional: (frontmatter.tier_7_provisional ?? []).filter((candidate) => {
      return !(
        candidate.group === params.decision.group_name
        && normalizePendingValue(candidate.value) === normalizedSource
      );
    }),
  };

  const changed = JSON.stringify(frontmatter) !== JSON.stringify(nextFrontmatter);
  if (!changed) {
    return false;
  }

  const rewritten = matter.stringify(parsed.content, nextFrontmatter);
  await Bun.write(params.notePath, rewritten);
  return true;
}

function createInitialCursor(notePaths: string[]): TaxonomyCheckpointCursor {
  return {
    note_paths: notePaths,
    current_index: 0,
  };
}

async function applyDecisionWithCheckpoint(params: {
  db: BunSQLiteDatabase;
  decision: TaxonomyProposalDecisionRecord;
  checkpoint: TaxonomyPropagationCheckpointRecord | null;
  notePaths: string[];
  resume: boolean;
  now: () => Date;
  batchSize: number;
  beforeNoteRewrite?: TaxonomyApplyOptions["beforeNoteRewrite"];
}): Promise<TaxonomyApplyDecisionResult> {
  const checkpointId = checkpointIdForProposal(params.decision.proposal_id);
  const nowIso = params.now().toISOString();

  if (params.checkpoint?.status === "completed") {
    return {
      proposalId: params.decision.proposal_id,
      status: "skipped",
      processedNotes: params.checkpoint.processed_notes,
      totalNotes: params.checkpoint.total_notes,
    };
  }

  let notePaths = params.notePaths;
  let cursor = createInitialCursor(notePaths);
  let processedNotes = 0;
  let startedAt = nowIso;

  if (params.resume && params.checkpoint) {
    cursor = taxonomyCheckpointCursorSchema.parse(params.checkpoint.cursor);
    notePaths = cursor.note_paths;
    processedNotes = params.checkpoint.processed_notes;
    startedAt = params.checkpoint.started_at;
  }

  persistCheckpoint(params.db, {
    checkpoint_id: checkpointId,
    proposal_id: params.decision.proposal_id,
    status: "in_progress",
    cursor,
    processed_notes: processedNotes,
    total_notes: notePaths.length,
    started_at: startedAt,
    updated_at: nowIso,
  });

  try {
    for (let index = cursor.current_index; index < notePaths.length; index += 1) {
      const notePath = notePaths[index];
      await params.beforeNoteRewrite?.({
        decision: params.decision,
        notePath,
        noteIndex: index,
      });

      const changed = await rewriteNoteForDecision({
        notePath,
        decision: params.decision,
      });

      if (changed) {
        // no-op placeholder for future metrics hooks
      }

      processedNotes = index + 1;
      const shouldFlush = processedNotes % params.batchSize === 0 || processedNotes === notePaths.length;
      if (shouldFlush) {
        persistCheckpoint(params.db, {
          checkpoint_id: checkpointId,
          proposal_id: params.decision.proposal_id,
          status: "in_progress",
          cursor: {
            note_paths: notePaths,
            current_index: processedNotes,
          },
          processed_notes: processedNotes,
          total_notes: notePaths.length,
          started_at: startedAt,
          updated_at: params.now().toISOString(),
        });
      }
    }

    const completedAt = params.now().toISOString();
    persistCheckpoint(params.db, {
      checkpoint_id: checkpointId,
      proposal_id: params.decision.proposal_id,
      status: "completed",
      cursor: {
        note_paths: notePaths,
        current_index: notePaths.length,
      },
      processed_notes: notePaths.length,
      total_notes: notePaths.length,
      started_at: startedAt,
      updated_at: completedAt,
      completed_at: completedAt,
    });

    return {
      proposalId: params.decision.proposal_id,
      status: "completed",
      processedNotes: notePaths.length,
      totalNotes: notePaths.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    persistCheckpoint(params.db, {
      checkpoint_id: checkpointId,
      proposal_id: params.decision.proposal_id,
      status: "error",
      cursor: {
        note_paths: notePaths,
        current_index: processedNotes,
      },
      processed_notes: processedNotes,
      total_notes: notePaths.length,
      started_at: startedAt,
      updated_at: params.now().toISOString(),
      last_error: message,
    });

    throw new Error(`Failed to apply ${params.decision.proposal_id}: ${message}`);
  }
}

export async function applyApprovedTaxonomyDecisions(params: {
  db: BunSQLiteDatabase;
  taxonomyManager: TaxonomyManager;
  vaultPath: string;
  researchRoot: string;
  options?: TaxonomyApplyOptions;
}): Promise<TaxonomyApplyResult> {
  const now = params.options?.now ?? (() => new Date());
  const batchSize = params.options?.batchSize ?? 25;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid batch size '${batchSize}'. Expected positive integer.`);
  }

  const rows = params.db
    .query(
      `
      SELECT
        proposal_id,
        operation_type,
        group_name,
        source_value,
        target_value,
        decision_status,
        decided_by,
        rationale,
        decided_at,
        updated_at
      FROM taxonomy_proposal_decisions
      WHERE decision_status = 'approved'
      ORDER BY decided_at ASC, proposal_id ASC;
      `,
    )
    .all() as Array<{
    proposal_id: string;
    operation_type: string;
    group_name: string;
    source_value: string;
    target_value: string;
    decision_status: string;
    decided_by: string | null;
    rationale: string | null;
    decided_at: string;
    updated_at: string;
  }>;

  if (rows.length === 0) {
    return { decisions: [] };
  }

  const decisions = rows.map((row) =>
    taxonomyProposalDecisionRecordSchema.parse({
      proposal_id: row.proposal_id,
      operation_type: taxonomyOperationTypeSchema.parse(row.operation_type),
      group_name: row.group_name,
      source_value: row.source_value,
      target_value: row.target_value,
      decision_status: row.decision_status,
      decided_by: row.decided_by ?? undefined,
      rationale: row.rationale ?? undefined,
      decided_at: row.decided_at,
      updated_at: row.updated_at,
    }),
  );

  const allStudyNotes = await listStudyNotes(params.vaultPath, params.researchRoot);
  let taxonomyState = await params.taxonomyManager.load();

  const results: TaxonomyApplyDecisionResult[] = [];

  for (const decision of decisions) {
    const normalizedSource = normalizeTrimmed(decision.source_value);
    const normalizedTarget = normalizeTrimmed(decision.target_value);
    if (!normalizedSource || !normalizedTarget) {
      throw new Error(
        `Malformed approved decision ${decision.proposal_id}: source/target must be non-empty values.`,
      );
    }

    const checkpointId = checkpointIdForProposal(decision.proposal_id);
    const existingCheckpoint = readCheckpointRow(params.db, checkpointId);

    const applicableNotes = params.options?.resume && existingCheckpoint
      ? existingCheckpoint.cursor.note_paths
      : await buildApplicableNoteList({
          notePaths: allStudyNotes,
          decision,
        });

    const decisionResult = await applyDecisionWithCheckpoint({
      db: params.db,
      decision,
      checkpoint: existingCheckpoint,
      notePaths: applicableNotes,
      resume: params.options?.resume ?? false,
      now,
      batchSize,
      beforeNoteRewrite: params.options?.beforeNoteRewrite,
    });

    results.push(decisionResult);

    taxonomyState = params.taxonomyManager.applyProposalDecision(taxonomyState, {
      group: decision.group_name,
      operation: decision.operation_type,
      sourceValue: normalizedSource,
      targetValue: normalizedTarget,
      appliedAt: now().toISOString(),
    });
  }

  await params.taxonomyManager.save(taxonomyState);

  return {
    decisions: results,
  };
}

export function describeCheckpointCursor(checkpoint: TaxonomyPropagationCheckpointRecord): string {
  const currentPath = checkpoint.cursor.note_paths[checkpoint.cursor.current_index - 1] ?? null;
  if (!currentPath) {
    return `processed ${checkpoint.processed_notes}/${checkpoint.total_notes}`;
  }

  return `processed ${checkpoint.processed_notes}/${checkpoint.total_notes} (last: ${currentPath})`;
}

export function formatApplyFailureContext(params: {
  checkpoint: TaxonomyPropagationCheckpointRecord;
  vaultPath: string;
}): string {
  const currentPath = params.checkpoint.cursor.note_paths[params.checkpoint.cursor.current_index] ?? null;
  const relativePath = currentPath ? relative(params.vaultPath, currentPath) : null;

  if (!relativePath) {
    return "No failing note path captured in checkpoint cursor.";
  }

  return `Resume from failing note: ${relativePath}`;
}
