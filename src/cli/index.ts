#!/usr/bin/env bun
import { Command } from "commander";
import { runInitCommand, type InitCommandOptions } from "./commands/init";
import { runSyncZoteroCommand, type SyncCommandOptions } from "./commands/sync";
import { runProcessCommand, type ProcessCommandOptions } from "./commands/process";
import { runStatusCommand, type StatusCommandOptions } from "./commands/status";
import { runRetryCommand, type RetryCommandOptions } from "./commands/retry";
import { runReprocessCommand, type ReprocessCommandOptions } from "./commands/reprocess";
import { runAuditCommand, type AuditCommandOptions } from "./commands/audit";
import {
  runLockStatusCommand,
  runLockClearCommand,
  type LockStatusCommandOptions,
  type LockClearCommandOptions,
} from "./commands/lock";
import {
  runTaxonomyReviewCommand,
  runTaxonomyApproveCommand,
  runTaxonomyRejectCommand,
  runTaxonomyApplyCommand,
  type TaxonomyReviewCommandOptions,
  type TaxonomyDecisionCommandOptions,
  type TaxonomyApplyCommandOptions,
} from "./commands/taxonomy";

export function createCliProgram(): Command {
  const program = new Command();

  program
    .name("rhizome")
    .description("Rhizome study intelligence CLI")
    .version("0.1.0");

  program
    .command("init")
    .description("Initialize Rhizome config, database, and vault folder structure")
    .option("--vault <path>", "Vault path")
    .option("--research-root <name>", "Research root folder name")
    .option("--zotero-user <id>", "Zotero user ID")
    .option("--zotero-key-env <name>", "Environment variable name holding Zotero API key")
    .option(
      "--zotero-collections <csv>",
      "Comma-separated Zotero collections to sync (default: all)",
    )
    .option("--unpaywall-email <email>", "Email used for Unpaywall API")
    .option("--ai-windows <csv>", "Comma-separated AI windows (HH:MM-HH:MM)")
    .option("--timezone <tz>", "Timezone for AI windows")
    .option("--non-interactive", "Disable prompts and require all required options")
    .option("--force", "Overwrite existing .siss config/db files")
    .action(async (options: InitCommandOptions) => {
      await runInitCommand(options);
    });

  program
    .command("status")
    .description("Show queue and pipeline status")
    .option(
      "--citekey <key>",
      "Show status for a specific study (compat selector; planned deprecation after first stable build in favor of rhizome_id/doi/pmid selectors)",
    )
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: StatusCommandOptions) => {
      await runStatusCommand(options);
    });

  program
    .command("process")
    .description("Run pipeline processing")
    .option("--ai", "Run AI-required stages")
    .option("--batch <n>", "Maximum jobs to process", (value) => Number.parseInt(value, 10))
    .option(
      "--citekey <key>",
      "Process jobs for a specific study only (compat selector; planned deprecation after first stable build in favor of rhizome_id/doi/pmid selectors)",
    )
    .action(async (options: ProcessCommandOptions) => {
      await runProcessCommand(options);
    });

  program
    .command("retry")
    .description("Retry failed or paused jobs")
    .option(
      "--citekey <key>",
      "Retry failed/paused jobs for a specific study only (compat selector; planned deprecation after first stable build in favor of rhizome_id/doi/pmid selectors)",
    )
    .option("--all-failed", "Retry all failed/paused jobs across studies")
    .option("--reset-retries", "Reset retry_count to 0 for retried jobs")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: RetryCommandOptions) => {
      await runRetryCommand(options);
    });

  program
    .command("reprocess")
    .description("Requeue jobs for deterministic stage reprocessing")
    .option(
      "--citekey <key>",
      "Reprocess jobs for a specific study only (compat selector; planned deprecation after first stable build in favor of rhizome_id/doi/pmid selectors)",
    )
    .option("--filter <expr>", "Reprocess studies selected by a supported filter expression")
    .option("--stage <name>", "Pipeline stage to reprocess")
    .option("--cascade", "Include downstream stage chain for the selected stage")
    .option("--dry-run", "Report would-change counters without mutating queued jobs")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: ReprocessCommandOptions) => {
      await runReprocessCommand(options);
    });

  program
    .command("audit")
    .description("Inspect historical pipeline run outcomes")
    .option(
      "--citekey <key>",
      "Filter audit history to a specific study citekey (compat selector; planned deprecation after first stable build in favor of rhizome_id/doi/pmid selectors)",
    )
    .option("--stage <name>", "Filter by pipeline stage")
    .option("--errors", "Show only failed/error rows")
    .option("--last <n>", "Return most recent N rows (default/cap applied)", (value) =>
      Number.parseInt(value, 10),
    )
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: AuditCommandOptions) => {
      await runAuditCommand(options);
    });

  const sync = program.command("sync").description("Sync external sources");
  sync
    .command("zotero")
    .description("Sync studies from Zotero")
    .option("--full", "Force full sync from version 0")
    .option("--collection <name>", "Filter to a Zotero collection", collectRepeat, [])
    .action(async (options: SyncCommandOptions) => {
      await runSyncZoteroCommand(options);
    });

  const lock = program.command("lock").description("Inspect and manage writer lock");
  lock
    .command("status")
    .description("Show lock holder and staleness")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: LockStatusCommandOptions) => {
      await runLockStatusCommand(options);
    });

  lock
    .command("clear")
    .description("Clear writer lock")
    .option("--force", "Required safety flag")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: LockClearCommandOptions) => {
      await runLockClearCommand(options);
    });

  const taxonomy = program.command("taxonomy").description("Review and manage taxonomy proposals");

  taxonomy
    .command("review")
    .description("Generate taxonomy review artifact with deterministic proposal IDs")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: TaxonomyReviewCommandOptions) => {
      await runTaxonomyReviewCommand(options);
    });

  taxonomy
    .command("approve")
    .description("Approve taxonomy proposal by deterministic ID")
    .requiredOption("--id <proposalId>", "Deterministic proposal ID from taxonomy review")
    .option("--by <identity>", "Reviewer identity")
    .option("--rationale <text>", "Decision rationale")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: TaxonomyDecisionCommandOptions) => {
      await runTaxonomyApproveCommand(options);
    });

  taxonomy
    .command("reject")
    .description("Reject taxonomy proposal by deterministic ID")
    .requiredOption("--id <proposalId>", "Deterministic proposal ID from taxonomy review")
    .option("--by <identity>", "Reviewer identity")
    .option("--rationale <text>", "Decision rationale")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: TaxonomyDecisionCommandOptions) => {
      await runTaxonomyRejectCommand(options);
    });

  taxonomy
    .command("apply")
    .description("Apply approved taxonomy decisions to taxonomy state and study notes")
    .option("--resume", "Resume from checkpoint errors/in-progress state")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: TaxonomyApplyCommandOptions) => {
      await runTaxonomyApplyCommand(options);
    });

  return program;
}

function collectRepeat(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = createCliProgram();
  await program.parseAsync(argv);
}

if (import.meta.main) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
