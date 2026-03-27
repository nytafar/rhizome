import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifierTaxonomyGroups } from "../../ai/schemas/classifier";
import { createEmptyTaxonomyState } from "../schema";
import { TaxonomyManager, TaxonomyPersistenceError } from "../manager";
import type { AtomicFs } from "../types";

const GROUPS = [...classifierTaxonomyGroups];

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "rhizome-taxonomy-manager-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeFilePath(root: string): string {
  return join(root, "Research", "_system", "taxonomy.json");
}

describe("TaxonomyManager", () => {
  test("loads empty state when taxonomy file does not exist", async () => {
    await withTempDir(async (root) => {
      const manager = new TaxonomyManager({
        filePath: makeFilePath(root),
        groups: GROUPS,
      });

      const state = await manager.load();

      expect(state).toEqual(createEmptyTaxonomyState(GROUPS));
    });
  });

  test("load rejects invalid JSON with path-scoped parse stage", async () => {
    await withTempDir(async (root) => {
      const filePath = makeFilePath(root);
      await mkdir(join(root, "Research", "_system"), { recursive: true });
      await writeFile(filePath, "{ not valid json", "utf8");

      const manager = new TaxonomyManager({ filePath, groups: GROUPS });

      await expect(manager.load()).rejects.toThrow("[taxonomy:parse]");
      await expect(manager.load()).rejects.toThrow(filePath);
    });
  });

  test("load rejects missing groups and leaves in-memory state unchanged", async () => {
    await withTempDir(async (root) => {
      const filePath = makeFilePath(root);
      await mkdir(join(root, "Research", "_system"), { recursive: true });

      const invalid = {
        version: 1,
        groups: {
          therapeutic_areas: { values: {}, pending: {} },
        },
      };
      await writeFile(filePath, JSON.stringify(invalid, null, 2), "utf8");

      const manager = new TaxonomyManager({ filePath, groups: GROUPS });
      const before = manager.getState();

      await expect(manager.load()).rejects.toThrow("[taxonomy:validate]");

      expect(manager.getState()).toEqual(before);
    });
  });

  test("load rejects invalid alias entries", async () => {
    await withTempDir(async (root) => {
      const filePath = makeFilePath(root);
      await mkdir(join(root, "Research", "_system"), { recursive: true });

      const state = createEmptyTaxonomyState(GROUPS);
      state.groups.mechanisms.values.hpa_axis = {
        count: 1,
        created_at: "2026-03-27T00:00:00.000Z",
        last_used_at: "2026-03-27T00:00:00.000Z",
        aliases: ["hpa", "hpa"],
      };

      await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");

      const manager = new TaxonomyManager({ filePath, groups: GROUPS });

      await expect(manager.load()).rejects.toThrow("[taxonomy:validate]");
    });
  });

  test("atomic save keeps original file intact when temp write fails", async () => {
    await withTempDir(async (root) => {
      const filePath = makeFilePath(root);
      await mkdir(join(root, "Research", "_system"), { recursive: true });

      const original = createEmptyTaxonomyState(GROUPS);
      original.groups.therapeutic_areas.values.adaptogen = {
        count: 2,
        created_at: "2026-03-20T00:00:00.000Z",
        last_used_at: "2026-03-21T00:00:00.000Z",
        aliases: [],
      };

      await writeFile(filePath, JSON.stringify(original, null, 2) + "\n", "utf8");
      const untouched = await readFile(filePath, "utf8");

      const failingFs: AtomicFs = {
        mkdir,
        readFile,
        rename: async (oldPath, newPath) => {
          await Bun.write(newPath, await Bun.file(oldPath).text());
        },
        writeFile: async () => {
          throw new Error("simulated write failure");
        },
        rm,
      };

      const manager = new TaxonomyManager({ filePath, groups: GROUPS, fs: failingFs });
      const nextState = createEmptyTaxonomyState(GROUPS);

      const save = manager.save(nextState);
      await expect(save).rejects.toBeInstanceOf(TaxonomyPersistenceError);
      await expect(save).rejects.toThrow("[taxonomy:write]");

      const after = await readFile(filePath, "utf8");
      expect(after).toBe(untouched);
    });
  });

  test("atomic save validates before touching disk", async () => {
    await withTempDir(async (root) => {
      const filePath = makeFilePath(root);
      await mkdir(join(root, "Research", "_system"), { recursive: true });

      const valid = createEmptyTaxonomyState(GROUPS);
      await writeFile(filePath, JSON.stringify(valid, null, 2) + "\n", "utf8");
      const before = await readFile(filePath, "utf8");

      const manager = new TaxonomyManager({ filePath, groups: GROUPS });

      const invalidState = {
        version: 999,
        groups: valid.groups,
      } as unknown as ReturnType<typeof createEmptyTaxonomyState>;

      await expect(manager.save(invalidState)).rejects.toThrow("[taxonomy:validate]");

      const after = await readFile(filePath, "utf8");
      expect(after).toBe(before);
    });
  });

  test("resolveAlias returns canonical value, null on miss, and errors on unsupported group", () => {
    const manager = new TaxonomyManager({
      filePath: "/tmp/taxonomy.json",
      groups: GROUPS,
    });

    const state = createEmptyTaxonomyState(GROUPS);
    state.groups.mechanisms.values.hpa_axis = {
      count: 3,
      created_at: "2026-03-01T00:00:00.000Z",
      last_used_at: "2026-03-02T00:00:00.000Z",
      aliases: ["hpa"],
    };

    expect(manager.resolveAlias(state, "mechanisms", "hpa")).toBe("hpa_axis");
    expect(manager.resolveAlias(state, "mechanisms", "no_match")).toBeNull();
    expect(() => manager.resolveAlias(state, "bad_group" as never, "hpa")).toThrow(
      "Unsupported taxonomy group",
    );
  });

  test("recordUsage deterministically increments count and last_used_at for canonical values", () => {
    const manager = new TaxonomyManager({
      filePath: "/tmp/taxonomy.json",
      groups: GROUPS,
      now: () => new Date("2026-03-27T00:00:00.000Z"),
    });

    const state = createEmptyTaxonomyState(GROUPS);
    state.groups.therapeutic_areas.values.stress = {
      count: 4,
      created_at: "2026-03-10T00:00:00.000Z",
      last_used_at: "2026-03-11T00:00:00.000Z",
      aliases: ["stress_support"],
    };

    const updated = manager.recordUsage(state, {
      group: "therapeutic_areas",
      value: "stress_support",
      usedAt: "2026-03-27T01:02:03.000Z",
    });

    expect(updated.groups.therapeutic_areas.values.stress.count).toBe(5);
    expect(updated.groups.therapeutic_areas.values.stress.last_used_at).toBe(
      "2026-03-27T01:02:03.000Z",
    );

    const withNewValue = manager.recordUsage(updated, {
      group: "therapeutic_areas",
      value: "fatigue",
    });

    expect(withNewValue.groups.therapeutic_areas.values.fatigue.count).toBe(1);
    expect(withNewValue.groups.therapeutic_areas.values.fatigue.created_at).toBe(
      "2026-03-27T00:00:00.000Z",
    );
    expect(withNewValue.groups.therapeutic_areas.values.fatigue.last_used_at).toBe(
      "2026-03-27T00:00:00.000Z",
    );
  });

  test("addPending dedupes by (group,value), enforces new: format, and tracks unique sources", () => {
    const manager = new TaxonomyManager({
      filePath: "/tmp/taxonomy.json",
      groups: GROUPS,
      now: () => new Date("2026-03-27T00:00:00.000Z"),
    });

    const state = createEmptyTaxonomyState(GROUPS);
    const first = manager.addPending(state, {
      group: "mechanisms",
      value: "new:hpa_axis_resilience",
      source: "classifier",
      seenAt: "2026-03-27T00:00:00.000Z",
    });

    const second = manager.addPending(first, {
      group: "mechanisms",
      value: "new:hpa_axis_resilience",
      source: "classifier",
      seenAt: "2026-03-27T01:00:00.000Z",
    });

    const third = manager.addPending(second, {
      group: "mechanisms",
      value: "new:hpa_axis_resilience",
      source: "reviewer",
      seenAt: "2026-03-27T02:00:00.000Z",
    });

    expect(third.groups.mechanisms.pending.hpa_axis_resilience).toEqual({
      count: 3,
      first_seen_at: "2026-03-27T00:00:00.000Z",
      last_seen_at: "2026-03-27T02:00:00.000Z",
      sources: ["classifier", "reviewer"],
    });

    expect(() =>
      manager.addPending(third, {
        group: "mechanisms",
        value: "hpa_axis_resilience",
      }),
    ).toThrow("new:<value>");
  });

  test("autoPromote promotes threshold hits, removes pending, and records promotion metadata", () => {
    const manager = new TaxonomyManager({
      filePath: "/tmp/taxonomy.json",
      groups: GROUPS,
    });

    const state = createEmptyTaxonomyState(GROUPS);
    state.groups.mechanisms.pending.hpa_axis_resilience = {
      count: 2,
      first_seen_at: "2026-03-27T00:00:00.000Z",
      last_seen_at: "2026-03-27T02:00:00.000Z",
      sources: ["classifier"],
    };
    state.groups.mechanisms.pending.sub_threshold = {
      count: 1,
      first_seen_at: "2026-03-27T00:00:00.000Z",
      last_seen_at: "2026-03-27T01:00:00.000Z",
      sources: ["classifier"],
    };

    const { state: promotedState, promoted } = manager.autoPromote(state, {
      threshold: 2,
      promotedAt: "2026-03-27T03:00:00.000Z",
    });

    expect(promoted).toEqual([
      {
        group: "mechanisms",
        value: "hpa_axis_resilience",
        count: 2,
        promoted_at: "2026-03-27T03:00:00.000Z",
        sources: ["classifier"],
      },
    ]);
    expect(promotedState.groups.mechanisms.pending.hpa_axis_resilience).toBeUndefined();
    expect(promotedState.groups.mechanisms.pending.sub_threshold).toBeDefined();
    expect(promotedState.groups.mechanisms.values.hpa_axis_resilience).toEqual({
      count: 2,
      created_at: "2026-03-27T03:00:00.000Z",
      last_used_at: "2026-03-27T03:00:00.000Z",
      aliases: [],
      promoted_at: "2026-03-27T03:00:00.000Z",
      promoted_sources: ["classifier"],
    });
  });
});
