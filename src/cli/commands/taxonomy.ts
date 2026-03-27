import { join } from "node:path";
import { loadConfig, type RhizomeConfig } from "../../config/loader";
import { resolveWorkspaceConfigPath } from "../../config/workspace-contract";
import { Database } from "../../db/database";
import { WriterLock, WriterLockError } from "../../lock/writer-lock";
import { TaxonomyManager } from "../../taxonomy/manager";
import {
  buildTaxonomyReviewProposals,
  renderTaxonomyReviewMarkdown,
  writeTaxonomyReviewArtifact,
  type TaxonomyReviewProposal,
} from "../../taxonomy/review";
import {
  taxonomyDecisionStatusSchema,
  taxonomyOperationTypeSchema,
  taxonomyProposalIdSchema,
} from "../../taxonomy/schema";
import type { TaxonomyProposalDecisionStatus } from "../../taxonomy/types";

export interface TaxonomyReviewCommandOptions {
  json?: boolean;
}

export interface TaxonomyDecisionCommandOptions {
  id?: string;
  by?: string;
  rationale?: string;
  json?: boolean;
}

export interface TaxonomyReviewCommandResult {
  artifactPath: string;
  proposals: TaxonomyReviewProposal[];
}

export interface TaxonomyDecisionCommandResult {
  proposalId: string;
  decisionStatus: TaxonomyProposalDecisionStatus;
  operationType: "rename" | "merge";
  groupName: string;
  sourceValue: string;
  targetValue: string;
  decidedBy?: string;
  rationale?: string;
  decidedAt: string;
}

export interface TaxonomyCommandDeps {
  cwd?: string;
  stdout?: Pick<typeof process.stdout, "write">;
  loadConfigFn?: (configPath: string) => Promise<RhizomeConfig>;
}

function resolveDbPath(cwd: string, config: RhizomeConfig): string {
  return join(cwd, config.data.db_path);
}

function resolveLockPath(cwd: string, config: RhizomeConfig): string {
  return join(cwd, config.pipeline.lock_path);
}

function resolveReviewArtifactPath(config: RhizomeConfig): string {
  return join(config.vault.path, config.vault.research_root, config.vault.system_folder, "taxonomy_review.md");
}

function normalizeDecisionId(id: string | undefined): string {
  const normalized = id?.trim();
  if (!normalized) {
    throw new Error("--id requires a non-empty value");
  }

  const validation = taxonomyProposalIdSchema.safeParse(normalized);
  if (!validation.success) {
    throw new Error(`Invalid proposal id '${normalized}'. Expected format proposal:<group>:<operation>:<source>`);
  }

  return validation.data;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

async function loadCommandConfig(cwd: string, deps: TaxonomyCommandDeps): Promise<RhizomeConfig> {
  const configPath = await resolveWorkspaceConfigPath(cwd);
  return (deps.loadConfigFn ?? loadConfig)(configPath);
}

function withHolder(error: WriterLockError): Error {
  const holder = error.metadata
    ? ` (pid=${error.metadata.pid}, command=${error.metadata.command})`
    : "";
  return new Error(`${error.message}${holder}`);
}

function findProposalById(proposals: TaxonomyReviewProposal[], proposalId: string): TaxonomyReviewProposal | null {
  for (const proposal of proposals) {
    if (proposal.proposal_id === proposalId) {
      return proposal;
    }
  }

  return null;
}

function renderReviewText(result: TaxonomyReviewCommandResult): string {
  return [
    `Taxonomy review artifact: ${result.artifactPath}`,
    `Proposals: ${result.proposals.length}`,
    "",
  ].join("\n");
}

function renderDecisionText(result: TaxonomyDecisionCommandResult): string {
  return [
    `Decision saved: ${result.proposalId}`,
    `Status: ${result.decisionStatus}`,
    `Operation: ${result.operationType}`,
    `Group: ${result.groupName}`,
    `Source -> Target: ${result.sourceValue} -> ${result.targetValue}`,
    "",
  ].join("\n");
}

export async function runTaxonomyReviewCommand(
  options: TaxonomyReviewCommandOptions,
  deps: TaxonomyCommandDeps = {},
): Promise<TaxonomyReviewCommandResult> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;
  const config = await loadCommandConfig(cwd, deps);

  const taxonomy = TaxonomyManager.fromConfig(config);
  const state = await taxonomy.load();

  const proposals = buildTaxonomyReviewProposals(state);
  const generatedAt = new Date().toISOString();
  const markdown = renderTaxonomyReviewMarkdown({
    generatedAt,
    proposals,
  });

  const artifactPath = resolveReviewArtifactPath(config);
  try {
    await writeTaxonomyReviewArtifact({
      artifactPath,
      markdown,
    });
  } catch (error) {
    throw new Error(`Failed to write taxonomy review artifact at ${artifactPath}: ${String(error)}`);
  }

  const result: TaxonomyReviewCommandResult = {
    artifactPath,
    proposals,
  };

  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(renderReviewText(result));
  }

  return result;
}

async function runTaxonomyDecisionCommand(params: {
  options: TaxonomyDecisionCommandOptions;
  decisionStatus: TaxonomyProposalDecisionStatus;
  commandLabel: string;
  deps?: TaxonomyCommandDeps;
}): Promise<TaxonomyDecisionCommandResult> {
  const cwd = params.deps?.cwd ?? process.cwd();
  const stdout = params.deps?.stdout ?? process.stdout;
  const config = await loadCommandConfig(cwd, params.deps ?? {});
  const proposalId = normalizeDecisionId(params.options.id);
  const decidedBy = normalizeOptional(params.options.by);
  const rationale = normalizeOptional(params.options.rationale);

  const database = new Database({ path: resolveDbPath(cwd, config) });
  database.init();

  const lock = new WriterLock({
    lockPath: resolveLockPath(cwd, config),
    staleTimeoutMs: config.pipeline.lock_stale_minutes * 60 * 1000,
  });

  try {
    await lock.acquire(params.commandLabel);
  } catch (error) {
    database.close();

    if (error instanceof WriterLockError) {
      throw withHolder(error);
    }

    throw error;
  }

  try {
    const taxonomy = TaxonomyManager.fromConfig(config);
    const state = await taxonomy.load();
    const proposals = buildTaxonomyReviewProposals(state);

    const proposal = findProposalById(proposals, proposalId);
    if (!proposal) {
      throw new Error(`Unknown proposal id '${proposalId}'. Run 'rhizome taxonomy review' to refresh available IDs.`);
    }

    taxonomyOperationTypeSchema.parse(proposal.operation_type);
    taxonomyDecisionStatusSchema.parse(params.decisionStatus);

    const decidedAt = new Date().toISOString();

    database.db.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      database.db
        .query(
          `
          INSERT INTO taxonomy_proposal_decisions (
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
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(proposal_id)
          DO UPDATE SET
            operation_type = excluded.operation_type,
            group_name = excluded.group_name,
            source_value = excluded.source_value,
            target_value = excluded.target_value,
            decision_status = excluded.decision_status,
            decided_by = excluded.decided_by,
            rationale = excluded.rationale,
            decided_at = excluded.decided_at,
            updated_at = excluded.updated_at;
          `,
        )
        .run(
          proposal.proposal_id,
          proposal.operation_type,
          proposal.group_name,
          proposal.source_value,
          proposal.target_value,
          params.decisionStatus,
          decidedBy ?? null,
          rationale ?? null,
          decidedAt,
          decidedAt,
        );

      database.db.exec("COMMIT;");
    } catch (error) {
      database.db.exec("ROLLBACK;");
      throw error;
    }

    const result: TaxonomyDecisionCommandResult = {
      proposalId: proposal.proposal_id,
      decisionStatus: params.decisionStatus,
      operationType: proposal.operation_type,
      groupName: proposal.group_name,
      sourceValue: proposal.source_value,
      targetValue: proposal.target_value,
      decidedBy,
      rationale,
      decidedAt,
    };

    if (params.options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(renderDecisionText(result));
    }

    return result;
  } finally {
    await lock.release();
    database.close();
  }
}

export async function runTaxonomyApproveCommand(
  options: TaxonomyDecisionCommandOptions,
  deps: TaxonomyCommandDeps = {},
): Promise<TaxonomyDecisionCommandResult> {
  return runTaxonomyDecisionCommand({
    options,
    decisionStatus: "approved",
    commandLabel: `rhizome taxonomy approve --id ${normalizeDecisionId(options.id)}`,
    deps,
  });
}

export async function runTaxonomyRejectCommand(
  options: TaxonomyDecisionCommandOptions,
  deps: TaxonomyCommandDeps = {},
): Promise<TaxonomyDecisionCommandResult> {
  return runTaxonomyDecisionCommand({
    options,
    decisionStatus: "rejected",
    commandLabel: `rhizome taxonomy reject --id ${normalizeDecisionId(options.id)}`,
    deps,
  });
}
