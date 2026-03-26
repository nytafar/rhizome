import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureVaultFolderStructure,
  getVaultFolderStructurePaths,
} from "../folder-creator";

const VAULT_CONFIG = {
  path: "/unused/in/creator",
  research_root: "Research",
  studies_folder: "studies",
  assets_folder: "_assets",
  study_notes_folder: "study-notes",
  imports_folder: "_imports",
  system_folder: "_system",
} as const;

describe("vault folder creator", () => {
  test("creates expected folder structure", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-vault-"));

    try {
      const { ensuredDirs } = await ensureVaultFolderStructure({
        vaultPath: root,
        vault: VAULT_CONFIG,
      });

      const expectedDirs = getVaultFolderStructurePaths({
        vaultPath: root,
        vault: VAULT_CONFIG,
      }).ensuredDirs;

      expect(new Set(ensuredDirs)).toEqual(new Set(expectedDirs));

      await Promise.all(
        expectedDirs.map(async (dir) => {
          const info = await stat(dir);
          expect(info.isDirectory()).toBe(true);
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is idempotent when called multiple times", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-vault-"));

    try {
      const first = await ensureVaultFolderStructure({
        vaultPath: root,
        vault: VAULT_CONFIG,
      });

      const second = await ensureVaultFolderStructure({
        vaultPath: root,
        vault: VAULT_CONFIG,
      });

      expect(new Set(second.ensuredDirs)).toEqual(new Set(first.ensuredDirs));

      await Promise.all(
        second.ensuredDirs.map(async (dir) => {
          const info = await stat(dir);
          expect(info.isDirectory()).toBe(true);
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
