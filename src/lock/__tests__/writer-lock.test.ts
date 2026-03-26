import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { WriterLock, WriterLockError } from "../writer-lock";

async function withTempLockPath<T>(run: (lockPath: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "rhizome-lock-"));
  const lockPath = join(dir, ".siss", "locks", "mutator.lock");

  try {
    return await run(lockPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("WriterLock", () => {
  test("acquire creates lock with metadata and heartbeat updates it", async () => {
    await withTempLockPath(async (lockPath) => {
      const lock = new WriterLock({
        lockPath,
        now: () => new Date("2026-03-25T20:00:00.000Z"),
      });

      const handle = await lock.acquire("rhizome process --stage summarize", 4242);
      expect(handle.metadata.pid).toBe(4242);
      expect(handle.metadata.command).toBe("rhizome process --stage summarize");

      const firstMetadata = await lock.readMetadata();
      expect(firstMetadata).toBeDefined();
      expect(firstMetadata?.acquired_at).toBe("2026-03-25T20:00:00.000Z");
      expect(firstMetadata?.heartbeat_at).toBe("2026-03-25T20:00:00.000Z");

      const heartbeatLock = new WriterLock({
        lockPath,
        now: () => new Date("2026-03-25T20:00:05.000Z"),
      });

      const updated = await heartbeatLock.heartbeat(4242);
      expect(updated.heartbeat_at).toBe("2026-03-25T20:00:05.000Z");
      expect(updated.acquired_at).toBe("2026-03-25T20:00:00.000Z");
    });
  });

  test("release removes lock file", async () => {
    await withTempLockPath(async (lockPath) => {
      const lock = new WriterLock({ lockPath });
      await lock.acquire("rhizome sync", 5050);
      await lock.release();

      const metadata = await lock.readMetadata();
      expect(metadata).toBeNull();
    });
  });

  test("stale lock is detected during acquire", async () => {
    await withTempLockPath(async (lockPath) => {
      await mkdir(join(lockPath, ".."), { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: 9999,
            command: "rhizome process",
            acquired_at: "2026-03-25T19:00:00.000Z",
            heartbeat_at: "2026-03-25T19:00:00.000Z",
          },
          null,
          2,
        ),
        "utf8",
      );

      const lock = new WriterLock({
        lockPath,
        staleTimeoutMs: 60_000,
        now: () => new Date("2026-03-25T20:00:00.000Z"),
      });

      await expect(lock.acquire("rhizome process --stage classify", 1001)).rejects.toMatchObject({
        name: "WriterLockError",
        code: "LOCK_STALE",
        stale: true,
      } satisfies Partial<WriterLockError>);
    });
  });

  test("concurrent acquire fails while live lock exists", async () => {
    await withTempLockPath(async (lockPath) => {
      const first = new WriterLock({
        lockPath,
        staleTimeoutMs: 300_000,
        now: () => new Date("2026-03-25T20:00:00.000Z"),
      });
      await first.acquire("rhizome sync", 1111);

      const second = new WriterLock({
        lockPath,
        staleTimeoutMs: 300_000,
        now: () => new Date("2026-03-25T20:00:10.000Z"),
      });

      await expect(second.acquire("rhizome process", 2222)).rejects.toMatchObject({
        name: "WriterLockError",
        code: "LOCK_ALREADY_HELD",
        stale: false,
      } satisfies Partial<WriterLockError>);
    });
  });

  test("supports explicit legacy lock path override for compatibility", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rhizome-lock-legacy-"));
    const lockPath = join(dir, ".rhizome", "locks", "mutator.lock");

    try {
      const lock = new WriterLock({ lockPath });
      await lock.acquire("rhizome process", 8080);

      const metadata = await lock.readMetadata();
      expect(metadata?.pid).toBe(8080);
      expect(metadata?.command).toBe("rhizome process");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
