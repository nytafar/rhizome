import { join } from "node:path";
import { loadConfig, type RhizomeConfig } from "../../config/loader";
import { resolveWorkspaceConfigPath } from "../../config/workspace-contract";
import { Database } from "../../db/database";
import { WriterLock, WriterLockError } from "../../lock/writer-lock";
import { ZoteroClient } from "../../zotero/client";
import { syncZoteroDelta, type ZoteroSyncClientLike, type ZoteroSyncResult } from "../../zotero/sync";

export interface SyncCommandOptions {
  full?: boolean;
  collection?: string[];
}

export interface SyncCommandResult extends ZoteroSyncResult {
  lockPath: string;
}

export interface SyncCommandDeps {
  cwd?: string;
  stdout?: Pick<typeof process.stdout, "write">;
  loadConfigFn?: (configPath: string) => Promise<RhizomeConfig>;
  createClient?: (config: RhizomeConfig) => ZoteroSyncClientLike;
}

function commandLabel(options: SyncCommandOptions): string {
  const parts = ["rhizome sync zotero"];
  if (options.full) {
    parts.push("--full");
  }

  for (const collection of options.collection ?? []) {
    parts.push(`--collection ${collection}`);
  }

  return parts.join(" ");
}

function resolveDbPath(cwd: string, config: RhizomeConfig): string {
  return join(cwd, config.data.db_path);
}

function resolveLockPath(cwd: string, config: RhizomeConfig): string {
  return join(cwd, config.pipeline.lock_path);
}

function normalizeCollections(collections: string[] | undefined): string[] | undefined {
  if (!collections || collections.length === 0) {
    return undefined;
  }

  const normalized = collections
    .flatMap((raw) => raw.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

export async function runSyncZoteroCommand(
  options: SyncCommandOptions,
  deps: SyncCommandDeps = {},
): Promise<SyncCommandResult> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;

  const configPath = await resolveWorkspaceConfigPath(cwd);
  const config = await (deps.loadConfigFn ?? loadConfig)(configPath);

  const database = new Database({ path: resolveDbPath(cwd, config) });
  database.init();

  const lock = new WriterLock({
    lockPath: resolveLockPath(cwd, config),
    staleTimeoutMs: config.pipeline.lock_stale_minutes * 60 * 1000,
  });

  try {
    await lock.acquire(commandLabel(options));
  } catch (error) {
    database.close();

    if (error instanceof WriterLockError) {
      const holder = error.metadata
        ? ` (pid=${error.metadata.pid}, command=${error.metadata.command})`
        : "";
      throw new Error(`${error.message}${holder}`);
    }

    throw error;
  }

  const client =
    deps.createClient?.(config) ??
    new ZoteroClient({
      userId: config.zotero.user_id,
      apiKey: config.zotero.api_key,
    });

  try {
    const result = await syncZoteroDelta({
      db: database.db,
      client,
      options: {
        full: options.full,
        collections: normalizeCollections(options.collection),
      },
    });

    stdout.write(
      `Zotero sync complete: ${result.syncedItems} synced (${result.newItems} new, ${result.updatedItems} updated, ${result.deletedFlagged} removed_upstream)\n`,
    );

    return {
      ...result,
      lockPath: resolveLockPath(cwd, config),
    };
  } finally {
    await lock.release();
    database.close();
  }
}
