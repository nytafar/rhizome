#!/usr/bin/env bun
import { Command } from "commander";
import { runInitCommand, type InitCommandOptions } from "./commands/init";
import { runSyncZoteroCommand, type SyncCommandOptions } from "./commands/sync";
import { runProcessCommand, type ProcessCommandOptions } from "./commands/process";
import { runStatusCommand, type StatusCommandOptions } from "./commands/status";
import {
  runLockStatusCommand,
  runLockClearCommand,
  type LockStatusCommandOptions,
  type LockClearCommandOptions,
} from "./commands/lock";

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
