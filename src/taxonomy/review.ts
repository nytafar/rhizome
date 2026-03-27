import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaxonomyDocument, TaxonomyGroupName, TaxonomyProposalOperation } from "./types";

export interface TaxonomyReviewProposal {
  proposal_id: string;
  operation_type: TaxonomyProposalOperation;
  group_name: TaxonomyGroupName;
  source_value: string;
  target_value: string;
  pending_count: number;
  last_seen_at: string;
  sources: string[];
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "value";
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findMergeTarget(params: {
  pendingValue: string;
  canonicalValues: string[];
}): string | undefined {
  const pendingComparable = normalizeComparable(params.pendingValue);
  if (pendingComparable.length === 0) {
    return undefined;
  }

  for (const canonical of params.canonicalValues) {
    const comparable = normalizeComparable(canonical);
    if (comparable.length === 0) {
      continue;
    }

    if (comparable === pendingComparable) {
      return canonical;
    }

    if (comparable.startsWith(pendingComparable) || pendingComparable.startsWith(comparable)) {
      return canonical;
    }
  }

  return undefined;
}

function buildProposalId(params: {
  group: TaxonomyGroupName;
  operation: TaxonomyProposalOperation;
  sourceValue: string;
}): string {
  const sourceToken = normalizeToken(params.sourceValue);
  return `proposal:${params.group}:${params.operation}:${sourceToken}`;
}

export function buildTaxonomyReviewProposals(state: TaxonomyDocument): TaxonomyReviewProposal[] {
  const proposals: TaxonomyReviewProposal[] = [];

  for (const group of Object.keys(state.groups).sort() as TaxonomyGroupName[]) {
    const groupState = state.groups[group];
    const canonicalValues = Object.keys(groupState.values).sort();
    const pendingValues = Object.keys(groupState.pending).sort();

    for (const pendingValue of pendingValues) {
      const pending = groupState.pending[pendingValue];
      const mergeTarget = findMergeTarget({
        pendingValue,
        canonicalValues,
      });

      const operation: TaxonomyProposalOperation = mergeTarget ? "merge" : "rename";
      const targetValue = mergeTarget ?? pendingValue;

      proposals.push({
        proposal_id: buildProposalId({
          group,
          operation,
          sourceValue: pendingValue,
        }),
        operation_type: operation,
        group_name: group,
        source_value: pendingValue,
        target_value: targetValue,
        pending_count: pending.count,
        last_seen_at: pending.last_seen_at,
        sources: [...pending.sources].sort(),
      });
    }
  }

  return proposals;
}

function renderSources(sources: string[]): string {
  if (sources.length === 0) {
    return "-";
  }

  return sources.join(", ");
}

function renderProposalsTable(proposals: TaxonomyReviewProposal[]): string {
  const header = [
    "| Proposal ID | Group | Operation | Source | Target | Count | Last Seen | Sources |",
    "|---|---|---|---|---|---:|---|---|",
  ];

  if (proposals.length === 0) {
    return [...header, "| _none_ | - | - | - | - | 0 | - | - |"]; 
  }

  const rows = proposals.map((proposal) => {
    return [
      `| \`${proposal.proposal_id}\``,
      proposal.group_name,
      proposal.operation_type,
      `\`${proposal.source_value}\``,
      `\`${proposal.target_value}\``,
      proposal.pending_count.toString(),
      proposal.last_seen_at,
      renderSources(proposal.sources),
      "",
    ].join(" | ");
  });

  return [...header, ...rows].join("\n");
}

export function renderTaxonomyReviewMarkdown(params: {
  generatedAt: string;
  proposals: TaxonomyReviewProposal[];
}): string {
  return [
    "# Taxonomy Review",
    "",
    `Generated at: ${params.generatedAt}`,
    "",
    "Review the proposals below, then run:",
    "- `rhizome taxonomy approve --id <proposal_id>`",
    "- `rhizome taxonomy reject --id <proposal_id>`",
    "",
    "## Proposals",
    renderProposalsTable(params.proposals),
    "",
  ].join("\n");
}

export async function writeTaxonomyReviewArtifact(params: {
  artifactPath: string;
  markdown: string;
}): Promise<void> {
  const directory = dirname(params.artifactPath);
  const tempPath = `${params.artifactPath}.tmp`;

  await mkdir(directory, { recursive: true });

  try {
    await writeFile(tempPath, params.markdown, "utf8");
    await rename(tempPath, params.artifactPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}
