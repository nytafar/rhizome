import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_WRITER_LOCK_PATH = ".rhizome/locks/mutator.lock";
export const DEFAULT_STALE_TIMEOUT_MS = 60_000;

export interface WriterLockMetadata {
  pid: number;
  command: string;
  acquired_at: string;
  heartbeat_at: string;
}

export interface WriterLockOptions {
  lockPath?: string;
  staleTimeoutMs?: number;
  now?: () => Date;
}

export interface WriterLockHandle {
  lockPath: string;
  metadata: WriterLockMetadata;
}

export type WriterLockErrorCode = "LOCK_ALREADY_HELD" | "LOCK_STALE" | "LOCK_NOT_OWNED";

export class WriterLockError extends Error {
  public readonly code: WriterLockErrorCode;
  public readonly lockPath: string;
  public readonly metadata: WriterLockMetadata | null;
  public readonly stale: boolean;

  public constructor(params: {
    code: WriterLockErrorCode;
    message: string;
    lockPath: string;
    metadata: WriterLockMetadata | null;
    stale: boolean;
  }) {
    super(params.message);
    this.name = "WriterLockError";
    this.code = params.code;
    this.lockPath = params.lockPath;
    this.metadata = params.metadata;
    this.stale = params.stale;
  }
}

export class WriterLock {
  private readonly lockPath: string;
  private readonly staleTimeoutMs: number;
  private readonly now: () => Date;

  public constructor(options: WriterLockOptions = {}) {
    this.lockPath = options.lockPath ?? DEFAULT_WRITER_LOCK_PATH;
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  public async acquire(command: string, pid = process.pid): Promise<WriterLockHandle> {
    await mkdir(dirname(this.lockPath), { recursive: true });

    const timestamp = this.now().toISOString();
    const metadata: WriterLockMetadata = {
      pid,
      command,
      acquired_at: timestamp,
      heartbeat_at: timestamp,
    };

    try {
      const fileHandle = await open(this.lockPath, "wx");
      await fileHandle.writeFile(this.serialize(metadata));
      await fileHandle.close();
      return { lockPath: this.lockPath, metadata };
    } catch (error) {
      if (!this.isErrno(error, "EEXIST")) {
        throw error;
      }

      const existing = await this.readMetadata();
      const stale = existing ? this.isStale(existing) : false;

      throw new WriterLockError({
        code: stale ? "LOCK_STALE" : "LOCK_ALREADY_HELD",
        message: stale
          ? `stale writer lock exists at ${this.lockPath}`
          : `writer already active (lock: ${this.lockPath})`,
        lockPath: this.lockPath,
        metadata: existing,
        stale,
      });
    }
  }

  public async heartbeat(expectedPid = process.pid): Promise<WriterLockMetadata> {
    const metadata = await this.readMetadata();
    if (!metadata || metadata.pid !== expectedPid) {
      throw new WriterLockError({
        code: "LOCK_NOT_OWNED",
        message: `cannot heartbeat lock at ${this.lockPath}; current process does not own lock`,
        lockPath: this.lockPath,
        metadata,
        stale: false,
      });
    }

    const updated: WriterLockMetadata = {
      ...metadata,
      heartbeat_at: this.now().toISOString(),
    };

    await writeFile(this.lockPath, this.serialize(updated), "utf8");
    return updated;
  }

  public async release(): Promise<void> {
    try {
      await unlink(this.lockPath);
    } catch (error) {
      if (this.isErrno(error, "ENOENT")) {
        return;
      }

      throw error;
    }
  }

  public async readMetadata(): Promise<WriterLockMetadata | null> {
    try {
      const raw = await readFile(this.lockPath, "utf8");
      return this.parse(raw);
    } catch (error) {
      if (this.isErrno(error, "ENOENT")) {
        return null;
      }

      throw error;
    }
  }

  public isStale(metadata: WriterLockMetadata): boolean {
    const heartbeatMs = Date.parse(metadata.heartbeat_at);
    if (Number.isNaN(heartbeatMs)) {
      return true;
    }

    return this.now().getTime() - heartbeatMs > this.staleTimeoutMs;
  }

  private parse(raw: string): WriterLockMetadata | null {
    if (!raw.trim()) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<WriterLockMetadata>;

    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.command !== "string" ||
      typeof parsed.acquired_at !== "string" ||
      typeof parsed.heartbeat_at !== "string"
    ) {
      return null;
    }

    return {
      pid: parsed.pid,
      command: parsed.command,
      acquired_at: parsed.acquired_at,
      heartbeat_at: parsed.heartbeat_at,
    };
  }

  private serialize(metadata: WriterLockMetadata): string {
    return `${JSON.stringify(metadata, null, 2)}\n`;
  }

  private isErrno(error: unknown, expectedCode: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === expectedCode;
  }
}
