import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_CONFIG_TEMPLATE,
  loadConfig,
  loadWorkspaceConfig,
  parseAndValidateConfig,
} from "../loader";

describe("config loader", () => {
  test("parses valid config and resolves env: references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rhizome-config-"));
    try {
      const path = join(dir, "config.yaml");
      await writeFile(path, DEFAULT_CONFIG_TEMPLATE);

      const config = await loadConfig(path, {
        ZOTERO_API_KEY: "secret-test-key",
      });

      expect(config.config_version).toBe(1);
      expect(config.zotero.api_key).toBe("secret-test-key");
      expect(config.ai.strategy).toBe("piped");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects unsupported config_version", () => {
    const invalidVersion = DEFAULT_CONFIG_TEMPLATE.replace(
      "config_version: 1",
      "config_version: 2",
    );

    expect(() => parseAndValidateConfig(invalidVersion)).toThrow(
      /Unsupported config_version/,
    );
  });

  test("rejects missing required env variable", () => {
    expect(() => parseAndValidateConfig(DEFAULT_CONFIG_TEMPLATE, {})).toThrow(
      /Missing required environment variable: ZOTERO_API_KEY/,
    );
  });

  test("rejects invalid schema shape", () => {
    const invalidConfig = DEFAULT_CONFIG_TEMPLATE.replace(
      'strategy: "piped"',
      'strategy: "invalid"',
    );

    expect(() =>
      parseAndValidateConfig(invalidConfig, {
        ZOTERO_API_KEY: "test-key",
      }),
    ).toThrow();
  });

  test("loadWorkspaceConfig falls back to legacy .rhizome config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rhizome-config-"));
    try {
      const legacyDir = join(dir, ".rhizome");
      await mkdir(legacyDir, { recursive: true });
      await writeFile(join(legacyDir, "config.yaml"), DEFAULT_CONFIG_TEMPLATE);

      const config = await loadWorkspaceConfig(dir, {
        ZOTERO_API_KEY: "legacy-secret-key",
      });

      expect(config.config_version).toBe(1);
      expect(config.zotero.api_key).toBe("legacy-secret-key");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadWorkspaceConfig returns actionable guidance when no config exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rhizome-config-"));
    try {
      await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/No workspace config found/);
      await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/rhizome init/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
