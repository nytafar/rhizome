import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../db/database";
import { PipelineStep } from "../../types/pipeline";
import type { ZoteroItem } from "../client";
import { syncZoteroDelta, type ZoteroSyncClientLike } from "../sync";

class FakeSyncClient implements ZoteroSyncClientLike {
  public constructor(
    private readonly options: {
      collections: Map<string, string>;
      items: ZoteroItem[];
      deleted?: string[];
    },
  ) {}

  public async *getItemsSince(version: number): AsyncGenerator<ZoteroItem> {
    for (const item of this.options.items) {
      if (item.version > version) {
        yield item;
      }
    }
  }

  public async getCollections(): Promise<Map<string, string>> {
    return this.options.collections;
  }

  public async getDeletedSince(version: number): Promise<{ keys: string[]; libraryVersion: number }> {
    if (version <= 0) {
      return {
        keys: [],
        libraryVersion: version,
      };
    }

    return {
      keys: this.options.deleted ?? [],
      libraryVersion:
        this.options.items.length > 0
          ? this.options.items.reduce((max, item) => Math.max(max, item.version), version)
          : version,
    };
  }
}

async function withDatabase<T>(run: (database: Database) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "rhizome-zotero-sync-"));
  const dbPath = join(dir, "rhizome.sqlite");

  try {
    const database = new Database({ path: dbPath });
    database.init();
    return await run(database);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeItem(input: {
  key: string;
  version: number;
  title: string;
  year: string;
  collectionKeys: string[];
  doi?: string;
  pmid?: string;
}): ZoteroItem {
  const extra = input.pmid ? `PMID: ${input.pmid}` : "";

  return {
    key: input.key,
    version: input.version,
    data: {
      itemType: "journalArticle",
      title: input.title,
      creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }],
      date: input.year,
      DOI: input.doi,
      extra,
      collections: input.collectionKeys,
    },
  };
}

describe("syncZoteroDelta", () => {
  test("first sync inserts studies and second sync with no changes enqueues nothing new", async () => {
    await withDatabase(async (database) => {
      const client = new FakeSyncClient({
        collections: new Map([
          ["C1", "Adaptogens"],
          ["C2", "Clinical Trials"],
        ]),
        items: [
          makeItem({
            key: "A1",
            version: 2,
            title: "Ashwagandha cortisol study",
            year: "2023",
            collectionKeys: ["C1"],
            doi: "10.1000/ashwagandha",
          }),
          makeItem({
            key: "B2",
            version: 3,
            title: "Rhodiola fatigue study",
            year: "2024",
            collectionKeys: ["C2"],
            pmid: "37291847",
          }),
        ],
      });

      const first = await syncZoteroDelta({
        db: database.db,
        client,
      });

      expect(first.fromVersion).toBe(0);
      expect(first.toVersion).toBe(3);
      expect(first.newItems).toBe(2);
      expect(first.updatedItems).toBe(0);
      expect(first.syncedItems).toBe(2);

      const studiesAfterFirst = database.db
        .query("SELECT COUNT(*) AS count FROM studies;")
        .get() as { count: number };
      expect(studiesAfterFirst.count).toBe(2);

      const jobsAfterFirst = database.db
        .query("SELECT COUNT(*) AS count FROM jobs WHERE stage = ? AND status = 'queued';")
        .get(PipelineStep.INGEST) as { count: number };
      expect(jobsAfterFirst.count).toBe(2);

      const second = await syncZoteroDelta({
        db: database.db,
        client,
      });

      expect(second.fromVersion).toBe(3);
      expect(second.toVersion).toBe(3);
      expect(second.newItems).toBe(0);
      expect(second.updatedItems).toBe(0);
      expect(second.syncedItems).toBe(0);

      const jobsAfterSecond = database.db
        .query("SELECT COUNT(*) AS count FROM jobs WHERE stage = ? AND status = 'queued';")
        .get(PipelineStep.INGEST) as { count: number };
      expect(jobsAfterSecond.count).toBe(2);

      const syncState = database.db
        .query(
          "SELECT library_version, last_sync_at, last_success_at, items_synced, sync_error FROM zotero_sync_state WHERE id = 1;",
        )
        .get() as {
        library_version: number;
        last_sync_at: string | null;
        last_success_at: string | null;
        items_synced: number;
        sync_error: string | null;
      };

      expect(syncState.library_version).toBe(3);
      expect(syncState.last_sync_at).not.toBeNull();
      expect(syncState.last_success_at).not.toBeNull();
      expect(syncState.items_synced).toBe(0);
      expect(syncState.sync_error).toBeNull();
    });
  });

  test("flags deleted upstream items in pipeline_steps_json", async () => {
    await withDatabase(async (database) => {
      const client = new FakeSyncClient({
        collections: new Map([["C1", "Adaptogens"]]),
        items: [
          makeItem({
            key: "DEL1",
            version: 4,
            title: "To be deleted",
            year: "2025",
            collectionKeys: ["C1"],
            doi: "10.1000/to-delete",
          }),
        ],
        deleted: ["DEL1"],
      });

      await syncZoteroDelta({ db: database.db, client });
      const second = await syncZoteroDelta({ db: database.db, client });
      expect(second.deletedFlagged).toBe(1);

      const row = database.db
        .query("SELECT pipeline_steps_json FROM studies WHERE zotero_key = ?;")
        .get("DEL1") as { pipeline_steps_json: string };

      const parsed = JSON.parse(row.pipeline_steps_json) as Record<string, unknown>;
      const step = parsed[PipelineStep.ZOTERO_SYNC] as Record<string, unknown>;

      expect(step.zotero_sync_status).toBe("removed_upstream");
      expect(step.removed_upstream_reason).toBe("deleted in Zotero");
      expect(step.removed_upstream_at).toBeString();
    });
  });

  test("supports collection filtering by resolved collection names", async () => {
    await withDatabase(async (database) => {
      const client = new FakeSyncClient({
        collections: new Map([
          ["C1", "Adaptogens"],
          ["C2", "Exclude Me"],
        ]),
        items: [
          makeItem({
            key: "COLL_A",
            version: 2,
            title: "Included",
            year: "2021",
            collectionKeys: ["C1"],
          }),
          makeItem({
            key: "COLL_B",
            version: 3,
            title: "Excluded",
            year: "2021",
            collectionKeys: ["C2"],
          }),
        ],
      });

      const result = await syncZoteroDelta({
        db: database.db,
        client,
        options: { collections: ["Adaptogens"] },
      });

      expect(result.syncedItems).toBe(1);
      expect(result.filteredItems).toBe(1);

      const rows = database.db
        .query("SELECT zotero_key FROM studies ORDER BY zotero_key ASC;")
        .all() as Array<{ zotero_key: string }>;

      expect(rows).toEqual([{ zotero_key: "COLL_A" }]);
    });
  });
});
