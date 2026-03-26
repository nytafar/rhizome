import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../db/database";
import { WriterLock } from "../../lock/writer-lock";
import { runInitCommand } from "../commands/init";
import { runSyncZoteroCommand } from "../commands/sync";
import { runProcessCommand } from "../commands/process";
import { runStatusCommand } from "../commands/status";
import { runLockClearCommand, runLockStatusCommand } from "../commands/lock";
import { CANONICAL_WORKSPACE_DIR, LEGACY_WORKSPACE_DIR } from "../../config/workspace-contract";
import type { ZoteroItem } from "../../zotero/client";

const INIT_ARGS = {
  nonInteractive: true,
  researchRoot: "Research",
  zoteroUser: "12345",
  zoteroKeyEnv: "ZOTERO_API_KEY",
  unpaywallEmail: "test@example.com",
  aiWindows: "17:00-19:00,23:00-01:00",
  timezone: "Europe/Oslo",
  force: true,
} as const;

async function withTempRhizome<T>(run: (root: string, vaultPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "rhizome-cli-commands-"));
  const previousZoteroKey = process.env.ZOTERO_API_KEY;

  try {
    process.env.ZOTERO_API_KEY = "test-zotero-key";

    const vaultPath = join(root, "vault");
    await mkdir(vaultPath, { recursive: true });

    await runInitCommand(
      {
        ...INIT_ARGS,
        vault: vaultPath,
      },
      { cwd: root },
    );

    return await run(root, vaultPath);
  } finally {
    if (previousZoteroKey === undefined) {
      delete process.env.ZOTERO_API_KEY;
    } else {
      process.env.ZOTERO_API_KEY = previousZoteroKey;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function makeFakeClient(items: ZoteroItem[]) {
  return {
    async *getItemsSince() {
      for (const item of items) {
        yield item;
      }
    },
    async getCollections() {
      return new Map<string, string>([["COLL_A", "Adaptogens"]]);
    },
    async getDeletedSince() {
      return { keys: [], libraryVersion: 42 };
    },
  };
}

async function moveConfigToLegacyWorkspace(root: string, rewriteWorkspacePaths = false): Promise<void> {
  const canonicalConfigPath = join(root, CANONICAL_WORKSPACE_DIR, "config.yaml");
  const legacyConfigPath = join(root, LEGACY_WORKSPACE_DIR, "config.yaml");

  const canonicalConfig = await Bun.file(canonicalConfigPath).text();
  const legacyConfig = rewriteWorkspacePaths
    ? canonicalConfig
        .replaceAll(`${CANONICAL_WORKSPACE_DIR}/locks/mutator.lock`, `${LEGACY_WORKSPACE_DIR}/locks/mutator.lock`)
        .replaceAll(`${CANONICAL_WORKSPACE_DIR}/siss.db`, `${LEGACY_WORKSPACE_DIR}/siss.db`)
        .replaceAll(`${CANONICAL_WORKSPACE_DIR}/skills/`, `${LEGACY_WORKSPACE_DIR}/skills/`)
    : canonicalConfig;

  await mkdir(join(root, LEGACY_WORKSPACE_DIR, "locks"), { recursive: true });
  await mkdir(join(root, LEGACY_WORKSPACE_DIR, "skills"), { recursive: true });
  await Bun.write(legacyConfigPath, legacyConfig);
  await rm(canonicalConfigPath, { force: true });
}

describe("CLI command handlers", () => {
  test("sync zotero imports studies and status reports queue + citekey detail", async () => {
    await withTempRhizome(async (root) => {
      const item: ZoteroItem = {
        key: "ITEM_001",
        version: 42,
        data: {
          itemType: "journalArticle",
          title: "Adaptogen Effects in Athletes",
          creators: [{ creatorType: "author", firstName: "Jane", lastName: "Smith" }],
          date: "2023",
          DOI: "10.1000/example.1",
          collections: ["COLL_A"],
          extra: "PMID: 12345678",
        },
      };

      const syncResult = await runSyncZoteroCommand(
        { full: true, collection: ["Adaptogens"] },
        {
          cwd: root,
          createClient: () => makeFakeClient([item]),
        },
      );

      expect(syncResult.newItems).toBe(1);
      expect(syncResult.updatedItems).toBe(0);

      const overview = await runStatusCommand({ json: true }, { cwd: root });
      expect(overview.mode).toBe("overview");
      expect(overview.overview?.queue["ingest.queued"]).toBe(1);

      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();
      const row = database.db
        .query("SELECT citekey FROM studies LIMIT 1;")
        .get() as { citekey: string };
      database.close();

      const detail = await runStatusCommand({ citekey: row.citekey, json: true }, { cwd: root });
      expect(detail.mode).toBe("study");
      expect(detail.study?.citekey).toBe(row.citekey);
      expect(detail.study?.pipeline_steps.zotero_sync).toBeDefined();
    });
  });

  test("status overview runs via legacy .rhizome config location after canonical config removal", async () => {
    await withTempRhizome(async (root) => {
      const item: ZoteroItem = {
        key: "ITEM_LEGACY_001",
        version: 7,
        data: {
          itemType: "journalArticle",
          title: "Legacy Config Discovery Coverage",
          creators: [{ creatorType: "author", firstName: "Alex", lastName: "Rivera" }],
          date: "2024",
          DOI: "10.1000/example.legacy",
          collections: ["COLL_A"],
        },
      };

      const syncResult = await runSyncZoteroCommand(
        { full: true, collection: ["Adaptogens"] },
        {
          cwd: root,
          createClient: () => makeFakeClient([item]),
        },
      );
      expect(syncResult.newItems).toBe(1);

      await moveConfigToLegacyWorkspace(root);

      const overview = await runStatusCommand({ json: true }, { cwd: root });
      expect(overview.mode).toBe("overview");
      expect(overview.overview?.totals.studies).toBe(1);
    });
  });

  test("lock status and clear --force manage writer lock state", async () => {
    await withTempRhizome(async (root) => {
      const lockPath = join(root, CANONICAL_WORKSPACE_DIR, "locks", "mutator.lock");
      const lock = new WriterLock({ lockPath });
      await lock.acquire("rhizome sync zotero", 4242);

      const active = await runLockStatusCommand({ json: true }, { cwd: root });
      expect(active.active).toBe(true);
      expect(active.metadata?.pid).toBe(4242);

      const cleared = await runLockClearCommand({ force: true, json: true }, { cwd: root });
      expect(cleared.cleared).toBe(true);

      const after = await runLockStatusCommand({ json: true }, { cwd: root });
      expect(after.active).toBe(false);
    });
  });

  test("process --ai runs without errors when no AI jobs are queued", async () => {
    await withTempRhizome(async (root) => {
      const result = await runProcessCommand({ ai: true, batch: 5 }, { cwd: root });

      expect(result.mode).toBe("ai");
      expect(result.result.processed).toBe(0);
      expect(result.result.failed).toBe(0);
    });
  });

  test("process --citekey limits processing to the selected study", async () => {
    await withTempRhizome(async (root) => {
      const items: ZoteroItem[] = [
        {
          key: "ITEM_A",
          version: 1,
          data: {
            itemType: "journalArticle",
            title: "Target Study",
            creators: [{ creatorType: "author", firstName: "Jane", lastName: "Target" }],
            date: "2023",
            DOI: "10.1000/example.target",
            collections: ["COLL_A"],
          },
        },
        {
          key: "ITEM_B",
          version: 2,
          data: {
            itemType: "journalArticle",
            title: "Other Study",
            creators: [{ creatorType: "author", firstName: "John", lastName: "Other" }],
            date: "2024",
            DOI: "10.1000/example.other",
            collections: ["COLL_A"],
          },
        },
      ];

      await runSyncZoteroCommand(
        { full: true, collection: ["Adaptogens"] },
        {
          cwd: root,
          createClient: () => makeFakeClient(items),
        },
      );

      const database = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      database.init();

      const studies = database.db
        .query("SELECT rhizome_id, citekey FROM studies ORDER BY citekey ASC;")
        .all() as Array<{ rhizome_id: string; citekey: string }>;
      expect(studies).toHaveLength(2);

      const target = studies[0];
      const other = studies[1];
      if (!target || !other) {
        throw new Error("Expected two studies for selector test");
      }

      database.close();

      const processResult = await runProcessCommand({ citekey: target.citekey }, { cwd: root });
      expect(processResult.mode).toBe("non_ai");
      expect(processResult.result.processed).toBeGreaterThan(0);

      const verifyDb = new Database({ path: join(root, CANONICAL_WORKSPACE_DIR, "siss.db") });
      verifyDb.init();

      const targetJobs = verifyDb.db
        .query("SELECT stage, status FROM jobs WHERE rhizome_id = ? ORDER BY id ASC;")
        .all(target.rhizome_id) as Array<{ stage: string; status: string }>;
      const otherJobs = verifyDb.db
        .query("SELECT stage, status FROM jobs WHERE rhizome_id = ? ORDER BY id ASC;")
        .all(other.rhizome_id) as Array<{ stage: string; status: string }>;

      expect(targetJobs.some((job) => job.stage === "ingest" && job.status === "complete")).toBe(true);
      expect(otherJobs.every((job) => !(job.stage === "ingest" && job.status === "complete"))).toBe(true);
      expect(otherJobs.some((job) => job.stage === "ingest" && job.status === "queued")).toBe(true);

      verifyDb.close();
    });
  });

  test("process --citekey rejects empty selector values", async () => {
    await withTempRhizome(async (root) => {
      await expect(runProcessCommand({ citekey: "   " }, { cwd: root })).rejects.toThrow(
        "--citekey requires a non-empty value",
      );
    });
  });

  test("status --citekey rejects empty selector values", async () => {
    await withTempRhizome(async (root) => {
      await expect(runStatusCommand({ citekey: "   " }, { cwd: root })).rejects.toThrow(
        "--citekey requires a non-empty value",
      );
    });
  });

  test("lock status resolves legacy .rhizome workspace config when canonical config is absent", async () => {
    await withTempRhizome(async (root) => {
      await moveConfigToLegacyWorkspace(root, true);

      const status = await runLockStatusCommand({ json: true }, { cwd: root });
      expect(status.lockPath).toBe(join(root, LEGACY_WORKSPACE_DIR, "locks", "mutator.lock"));
      expect(status.active).toBe(false);
    });
  });
});
