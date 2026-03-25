#!/usr/bin/env bun
import { Command } from "commander";
import { runInitCommand, type InitCommandOptions } from "./commands/init";

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

  return program;
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
