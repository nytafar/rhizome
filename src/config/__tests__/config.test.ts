import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_CONFIG_TEMPLATE,
  loadConfig,
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
});
