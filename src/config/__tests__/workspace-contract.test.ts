import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CANONICAL_WORKSPACE_DIR,
  CONFIG_FILENAME,
  LEGACY_WORKSPACE_DIR,
  discoverWorkspaceConfig,
  resolveWorkspaceConfigPath,
} from "../workspace-contract";

describe("workspace contract resolver", () => {
  test("discovers canonical .siss config when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rhizome-workspace-contract-"));
    try {
      const canonicalDir = join(dir, CANONICAL_WORKSPACE_DIR);
      await mkdir(canonicalDir, { recursive: true });
      const canonicalConfigPath = join(canonicalDir, CONFIG_FILENAME);
      await writeFile(canonicalConfigPath, "config_version: 1\n");

      const discovered = await discoverWorkspaceConfig(dir);

      expect(discovered.kind).toBe("canonical");
      if (discovered.kind === "canonical") {
        expect(discovered.configPath).toBe(canonicalConfigPath);
      }

      await expect(resolveWorkspaceConfigPath(dir)).resolves.toBe(canonicalConfigPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to legacy .rhizome config when canonical is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rhizome-workspace-contract-"));
    try {
      const legacyDir = join(dir, LEGACY_WORKSPACE_DIR);
      await mkdir(legacyDir, { recursive: true });
      const legacyConfigPath = join(legacyDir, CONFIG_FILENAME);
      await writeFile(legacyConfigPath, "config_version: 1\n");

      const discovered = await discoverWorkspaceConfig(dir);

      expect(discovered.kind).toBe("legacy");
      if (discovered.kind === "legacy") {
        expect(discovered.configPath).toBe(legacyConfigPath);
        expect(discovered.migrationGuidance).toContain("Migrate to .siss/config.yaml");
      }

      await expect(resolveWorkspaceConfigPath(dir)).resolves.toBe(legacyConfigPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns actionable guidance when no config contract exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rhizome-workspace-contract-"));
    try {
      const discovered = await discoverWorkspaceConfig(dir);

      expect(discovered.kind).toBe("missing");
      if (discovered.kind === "missing") {
        expect(discovered.guidance).toContain("No workspace config found");
        expect(discovered.guidance).toContain("rhizome init");
        expect(discovered.guidance).toContain(".siss/config.yaml");
        expect(discovered.guidance).toContain(".rhizome/config.yaml");
      }

      await expect(resolveWorkspaceConfigPath(dir)).rejects.toThrow(/No workspace config found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
