import type { Database as BunSQLiteDatabase } from "bun:sqlite";
import { PipelineOverallStatus, PipelineStep } from "../types/pipeline";
import { generateCitekey } from "../utils/citekey";
import type { ZoteroItem } from "./client";
import { mapZoteroItemToStudyRecord, type MappedStudyRecord } from "./field-mapper";

interface ZoteroSyncStateRow {
  library_version: number;
}

interface StudyRow {
  rhizome_id: string;
  citekey: string;
  doi: string | null;
  pmid: string | null;
  zotero_key: string | null;
  zotero_version: number | null;
  pipeline_steps_json: string;
}

export interface ZoteroSyncClientLike {
  getItemsSince(version: number): AsyncGenerator<ZoteroItem>;
  getCollections(): Promise<Map<string, string>>;
  getDeletedSince?(
    version: number,
  ): Promise<string[] | { keys: string[]; libraryVersion?: number }>;
}

export interface ZoteroSyncOptions {
  full?: boolean;
  collections?: string[];
  now?: () => Date;
  onEvent?: (event: ZoteroSyncEvent) => void;
}

export type ZoteroSyncEvent =
  | { type: "start"; fromVersion: number; full: boolean }
  | { type: "new"; rhizomeId: string; zoteroKey: string }
  | { type: "updated"; rhizomeId: string; zoteroKey: string }
  | { type: "removed_upstream"; rhizomeId: string; zoteroKey: string }
  | { type: "finish"; toVersion: number; syncedItems: number; newItems: number; updatedItems: number };

export interface ZoteroSyncResult {
  fromVersion: number;
  toVersion: number;
  syncedItems: number;
  newItems: number;
  updatedItems: number;
  skippedItems: number;
  filteredItems: number;
  deletedFlagged: number;
}

export async function syncZoteroDelta(params: {
  db: BunSQLiteDatabase;
  client: ZoteroSyncClientLike;
  options?: ZoteroSyncOptions;
}): Promise<ZoteroSyncResult> {
  const { db, client } = params;
  const options = params.options ?? {};

  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const currentState = readSyncState(db);
  const fromVersion = options.full ? 0 : currentState.library_version;
  options.onEvent?.({ type: "start", fromVersion, full: Boolean(options.full) });

  const collectionMap = await client.getCollections();
  const filterSet = normalizeCollectionFilter(options.collections);

  let highestSeenVersion = fromVersion;
  let syncedItems = 0;
  let newItems = 0;
  let updatedItems = 0;
  let skippedItems = 0;
  let filteredItems = 0;
  let deletedFlagged = 0;

  try {
    for await (const item of client.getItemsSince(fromVersion)) {
      highestSeenVersion = Math.max(highestSeenVersion, item.version);

      const mapped = mapZoteroItemToStudyRecord(item, {
        collectionNamesByKey: collectionMap,
      });

      if (!mapped) {
        skippedItems += 1;
        continue;
      }

      if (!passesCollectionFilter(mapped, filterSet)) {
        filteredItems += 1;
        continue;
      }

      syncedItems += 1;
      const outcome = upsertMappedStudy(db, mapped, startedAt);

      if (outcome === "new") {
        newItems += 1;
        const rhizomeId = findRhizomeIdByZoteroKey(db, mapped.zotero_key);
        if (rhizomeId) {
          options.onEvent?.({ type: "new", rhizomeId, zoteroKey: mapped.zotero_key });
        }
      } else if (outcome === "updated") {
        updatedItems += 1;
        const rhizomeId = findRhizomeIdByZoteroKey(db, mapped.zotero_key);
        if (rhizomeId) {
          options.onEvent?.({ type: "updated", rhizomeId, zoteroKey: mapped.zotero_key });
        }
      } else {
        skippedItems += 1;
      }
    }

    const deletedResult = client.getDeletedSince
      ? await client.getDeletedSince(fromVersion)
      : [];
    const { keys: deletedKeys, libraryVersion: deletedLibraryVersion } = normalizeDeletedResult(
      deletedResult,
      fromVersion,
    );
    highestSeenVersion = Math.max(highestSeenVersion, deletedLibraryVersion);

    for (const key of deletedKeys) {
      const rhizomeId = markRemovedUpstream(db, key, startedAt);
      if (rhizomeId) {
        deletedFlagged += 1;
        options.onEvent?.({ type: "removed_upstream", rhizomeId, zoteroKey: key });
      }
    }

    const toVersion = highestSeenVersion;
    writeSyncState(db, {
      libraryVersion: toVersion,
      lastSyncAt: startedAt,
      lastSuccessAt: startedAt,
      itemsSynced: syncedItems,
      syncError: null,
    });

    options.onEvent?.({
      type: "finish",
      toVersion,
      syncedItems,
      newItems,
      updatedItems,
    });

    return {
      fromVersion,
      toVersion,
      syncedItems,
      newItems,
      updatedItems,
      skippedItems,
      filteredItems,
      deletedFlagged,
    };
  } catch (error) {
    writeSyncState(db, {
      libraryVersion: currentState.library_version,
      lastSyncAt: startedAt,
      lastSuccessAt: null,
      itemsSynced: 0,
      syncError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function upsertMappedStudy(
  db: BunSQLiteDatabase,
  mapped: MappedStudyRecord,
  nowIso: string,
): "new" | "updated" | "skipped" {
  const existing = findExistingStudy(db, mapped);
  const existingZoteroVersion = existing?.zotero_version ?? null;

  if (existing && existing.zotero_key === mapped.zotero_key && existingZoteroVersion === mapped.zotero_version) {
    return "skipped";
  }

  if (!existing) {
    const rhizomeId = crypto.randomUUID();
    const citekey = buildUniqueCitekey(db, mapped);
    const pipelineStepsJson = buildPipelineStepsJson({
      previousJson: "{}",
      nowIso,
      sourceCollections: mapped.source_collections,
    });

    db.query(
      `
      INSERT INTO studies (
        rhizome_id,
        citekey,
        title,
        doi,
        pmid,
        zotero_key,
        zotero_version,
        zotero_sync_status,
        removed_upstream_at,
        removed_upstream_reason,
        source_collections_json,
        source,
        pipeline_overall,
        pipeline_steps_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
    ).run(
      rhizomeId,
      citekey,
      mapped.title,
      mapped.doi ?? null,
      mapped.pmid ?? null,
      mapped.zotero_key,
      mapped.zotero_version,
      "active",
      null,
      null,
      serializeStringArray(mapped.source_collections),
      "zotero",
      PipelineOverallStatus.NOT_STARTED,
      pipelineStepsJson,
      nowIso,
      nowIso,
    );

    enqueueIfNotActive(db, rhizomeId, PipelineStep.INGEST);
    return "new";
  }

  const pipelineStepsJson = buildPipelineStepsJson({
    previousJson: existing.pipeline_steps_json,
    nowIso,
    sourceCollections: mapped.source_collections,
  });

  db.query(
    `
    UPDATE studies
    SET
      title = ?,
      doi = ?,
      pmid = ?,
      zotero_key = ?,
      zotero_version = ?,
      zotero_sync_status = ?,
      removed_upstream_at = ?,
      removed_upstream_reason = ?,
      source_collections_json = ?,
      source = ?,
      pipeline_steps_json = ?,
      updated_at = ?
    WHERE rhizome_id = ?;
    `,
  ).run(
    mapped.title,
    mapped.doi ?? null,
    mapped.pmid ?? null,
    mapped.zotero_key,
    mapped.zotero_version,
    "active",
    null,
    null,
    serializeStringArray(mapped.source_collections),
    "zotero",
    pipelineStepsJson,
    nowIso,
    existing.rhizome_id,
  );

  enqueueIfNotActive(db, existing.rhizome_id, PipelineStep.ZOTERO_SYNC);
  return "updated";
}

function findExistingStudy(db: BunSQLiteDatabase, mapped: MappedStudyRecord): StudyRow | null {
  const byZoteroKey = db
    .query(
      `
      SELECT rhizome_id, citekey, doi, pmid, zotero_key, zotero_version, pipeline_steps_json
      FROM studies
      WHERE zotero_key = ?
      LIMIT 1;
      `,
    )
    .get(mapped.zotero_key) as StudyRow | null;

  if (byZoteroKey) {
    return byZoteroKey;
  }

  if (mapped.doi) {
    const byDoi = db
      .query(
        `
        SELECT rhizome_id, citekey, doi, pmid, zotero_key, zotero_version, pipeline_steps_json
        FROM studies
        WHERE lower(doi) = lower(?)
        LIMIT 1;
        `,
      )
      .get(mapped.doi) as StudyRow | null;

    if (byDoi) {
      return byDoi;
    }
  }

  if (mapped.pmid) {
    const byPmid = db
      .query(
        `
        SELECT rhizome_id, citekey, doi, pmid, zotero_key, zotero_version, pipeline_steps_json
        FROM studies
        WHERE pmid = ?
        LIMIT 1;
        `,
      )
      .get(mapped.pmid) as StudyRow | null;

    if (byPmid) {
      return byPmid;
    }
  }

  return null;
}

function buildUniqueCitekey(db: BunSQLiteDatabase, mapped: MappedStudyRecord): string {
  const existing = db.query("SELECT citekey FROM studies;").all() as Array<{ citekey: string }>;

  return generateCitekey(
    {
      authors: mapped.authors,
      year: mapped.year ?? new Date().getUTCFullYear(),
      title: mapped.title || "study",
    },
    existing.map((row) => row.citekey),
  );
}

function enqueueIfNotActive(db: BunSQLiteDatabase, rhizomeId: string, stage: PipelineStep): void {
  const active = db
    .query(
      `
      SELECT id
      FROM jobs
      WHERE rhizome_id = ?
        AND stage = ?
        AND status IN ('queued', 'processing')
      LIMIT 1;
      `,
    )
    .get(rhizomeId, stage) as { id: number } | null;

  if (active) {
    return;
  }

  db.query(
    `
    INSERT INTO jobs (rhizome_id, stage, status, priority, ai_window_required)
    VALUES (?, ?, 'queued', 0, false);
    `,
  ).run(rhizomeId, stage);
}

function markRemovedUpstream(db: BunSQLiteDatabase, zoteroKey: string, nowIso: string): string | null {
  const existing = db
    .query(
      `
      SELECT rhizome_id, pipeline_steps_json
      FROM studies
      WHERE zotero_key = ?
      LIMIT 1;
      `,
    )
    .get(zoteroKey) as Pick<StudyRow, "rhizome_id" | "pipeline_steps_json"> | null;

  if (!existing) {
    return null;
  }

  const pipelineStepsJson = buildPipelineStepsJson({
    previousJson: existing.pipeline_steps_json,
    nowIso,
    sourceCollections: undefined,
  });

  db.query(
    `
    UPDATE studies
    SET
      zotero_sync_status = ?,
      removed_upstream_at = ?,
      removed_upstream_reason = ?,
      pipeline_steps_json = ?,
      updated_at = ?
    WHERE rhizome_id = ?;
    `,
  ).run("removed_upstream", nowIso, "deleted in Zotero", pipelineStepsJson, nowIso, existing.rhizome_id);

  return existing.rhizome_id;
}

function buildPipelineStepsJson(params: {
  previousJson: string;
  nowIso: string;
  sourceCollections: string[] | undefined;
}): string {
  const base = parseJsonObject(params.previousJson);

  const nextStep = {
    ...(isRecord(base[PipelineStep.ZOTERO_SYNC]) ? base[PipelineStep.ZOTERO_SYNC] : {}),
    status: "complete",
    updated_at: params.nowIso,
    retries: 0,
    source_collections: params.sourceCollections,
  };

  base[PipelineStep.ZOTERO_SYNC] = nextStep;
  return JSON.stringify(base);
}

function serializeStringArray(values: string[] | undefined): string | null {
  if (!values || values.length === 0) {
    return null;
  }

  return JSON.stringify(values);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readSyncState(db: BunSQLiteDatabase): ZoteroSyncStateRow {
  const row = db
    .query(
      `
      SELECT library_version
      FROM zotero_sync_state
      WHERE id = 1
      LIMIT 1;
      `,
    )
    .get() as ZoteroSyncStateRow | null;

  if (!row) {
    return { library_version: 0 };
  }

  return row;
}

function writeSyncState(
  db: BunSQLiteDatabase,
  input: {
    libraryVersion: number;
    lastSyncAt: string;
    lastSuccessAt: string | null;
    itemsSynced: number;
    syncError: string | null;
  },
): void {
  db.query(
    `
    INSERT INTO zotero_sync_state (
      id,
      library_version,
      last_sync_at,
      last_success_at,
      items_synced,
      sync_error
    )
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id)
    DO UPDATE SET
      library_version = excluded.library_version,
      last_sync_at = excluded.last_sync_at,
      last_success_at = CASE
        WHEN excluded.last_success_at IS NULL THEN zotero_sync_state.last_success_at
        ELSE excluded.last_success_at
      END,
      items_synced = excluded.items_synced,
      sync_error = excluded.sync_error;
    `,
  ).run(
    input.libraryVersion,
    input.lastSyncAt,
    input.lastSuccessAt,
    input.itemsSynced,
    input.syncError,
  );
}

function normalizeCollectionFilter(collections: string[] | undefined): Set<string> | null {
  if (!collections || collections.length === 0) {
    return null;
  }

  const normalized = collections
    .map((collection) => collection.trim().toLowerCase())
    .filter((collection) => collection.length > 0);

  return normalized.length > 0 ? new Set(normalized) : null;
}

function passesCollectionFilter(
  mapped: MappedStudyRecord,
  filterSet: Set<string> | null,
): boolean {
  if (!filterSet) {
    return true;
  }

  if (!mapped.source_collections || mapped.source_collections.length === 0) {
    return false;
  }

  return mapped.source_collections.some((collection) =>
    filterSet.has(collection.trim().toLowerCase()),
  );
}

function findRhizomeIdByZoteroKey(db: BunSQLiteDatabase, zoteroKey: string): string | null {
  const row = db
    .query("SELECT rhizome_id FROM studies WHERE zotero_key = ? LIMIT 1;")
    .get(zoteroKey) as { rhizome_id: string } | null;

  return row?.rhizome_id ?? null;
}

function normalizeDeletedResult(
  deletedResult: string[] | { keys: string[]; libraryVersion?: number },
  fallbackVersion: number,
): { keys: string[]; libraryVersion: number } {
  if (Array.isArray(deletedResult)) {
    return {
      keys: deletedResult,
      libraryVersion: fallbackVersion,
    };
  }

  return {
    keys: deletedResult.keys,
    libraryVersion:
      typeof deletedResult.libraryVersion === "number" && Number.isFinite(deletedResult.libraryVersion)
        ? deletedResult.libraryVersion
        : fallbackVersion,
  };
}
