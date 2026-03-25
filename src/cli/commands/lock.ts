import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type RhizomeConfig } from "../../config/loader";
import { WriterLock } from "../../lock/writer-lock";

export interface LockStatusCommandOptions {
  json?: boolean;
}

export interface LockClearCommandOptions {
  force?: boolean;
  json?: boolean;
}

export interface LockStatusResult {
  lockPath: string;
  active: boolean;
  stale: boolean;
  metadata: {
    pid: number;
    command: string;
    acquired_at: string;
    heartbeat_at: string;
  } | null;
}

export interface LockClearResult {
  lockPath: string;
  cleared: boolean;
}

export interface LockCommandDeps {
  cwd?: string;
  stdout?: Pick<typeof process.stdout, "write">;
  loadConfigFn?: (configPath: string) => Promise<RhizomeConfig>;
}

function resolveLockPath(cwd: string, config: RhizomeConfig): string {
  return join(cwd, config.pipeline.lock_path);
}

async function readLock(cwd: string, deps: LockCommandDeps): Promise<{
  lock: WriterLock;
  lockPath: string;
}> {
  const configPath = join(cwd, ".siss", "config.yaml");
  const config = await (deps.loadConfigFn ?? loadConfig)(configPath);
  const lockPath = resolveLockPath(cwd, config);

  const lock = new WriterLock({
    lockPath,
    staleTimeoutMs: config.pipeline.lock_stale_minutes * 60 * 1000,
  });

  return { lock, lockPath };
}

export async function runLockStatusCommand(
  options: LockStatusCommandOptions,
  deps: LockCommandDeps = {},
): Promise<LockStatusResult> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;

  const { lock, lockPath } = await readLock(cwd, deps);
  const metadata = await lock.readMetadata();

  const result: LockStatusResult = {
    lockPath,
    active: metadata !== null,
    stale: metadata ? lock.isStale(metadata) : false,
    metadata,
  };

  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!metadata) {
    stdout.write(`No active writer lock (${lockPath})\n`);
  } else {
    stdout.write(
      `Writer lock active (${lockPath})\n` +
        `pid=${metadata.pid} command=${metadata.command}\n` +
        `acquired_at=${metadata.acquired_at} heartbeat_at=${metadata.heartbeat_at}\n` +
        `stale=${result.stale}\n`,
    );
  }

  return result;
}

export async function runLockClearCommand(
  options: LockClearCommandOptions,
  deps: LockCommandDeps = {},
): Promise<LockClearResult> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;

  if (!options.force) {
    throw new Error("Refusing to clear writer lock without --force");
  }

  const { lockPath } = await readLock(cwd, deps);

  await rm(lockPath, { force: true });

  const result: LockClearResult = {
    lockPath,
    cleared: true,
  };

  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(`Cleared writer lock at ${lockPath}\n`);
  }

  return result;
}
