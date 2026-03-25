import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAndValidateConfig } from "../../config/loader";
import { getVaultFolderStructurePaths } from "../../vault/folder-creator";
import { runInitCommand } from "../commands/init";

describe("rhizome init", () => {
  test("creates config, sqlite db, and folder structure in non-interactive mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-cli-init-"));

    try {
      const vaultPath = join(root, "vault");
      await mkdir(vaultPath, { recursive: true });

      const result = await runInitCommand(
        {
          nonInteractive: true,
          vault: vaultPath,
          researchRoot: "Research",
          zoteroUser: "12345",
          zoteroKeyEnv: "ZOTERO_API_KEY",
          unpaywallEmail: "test@example.com",
          aiWindows: "17:00-19:00,23:00-01:00",
          timezone: "Europe/Oslo",
          zoteroCollections: "Adaptogens,Clinical Trials",
        },
        { cwd: root },
      );

      const configContent = await Bun.file(result.configPath).text();
      const parsed = parseAndValidateConfig(configContent, {
        ZOTERO_API_KEY: "test-secret",
      });

      expect(parsed.vault.path).toBe(vaultPath);
      expect(parsed.zotero.collections).toEqual(["Adaptogens", "Clinical Trials"]);
      expect(parsed.ai.windows).toEqual(["17:00-19:00", "23:00-01:00"]);
      expect(parsed.data.db_path).toBe(".siss/siss.db");

      const dbInfo = await stat(result.dbPath);
      expect(dbInfo.isFile()).toBe(true);

      const expectedDirs = getVaultFolderStructurePaths({
        vaultPath,
        vault: {
          path: vaultPath,
          research_root: "Research",
          studies_folder: "studies",
          assets_folder: "_assets",
          study_notes_folder: "study-notes",
          imports_folder: "_imports",
          system_folder: "_system",
        },
      }).ensuredDirs;

      await Promise.all(
        expectedDirs.map(async (dir) => {
          const dirInfo = await stat(dir);
          expect(dirInfo.isDirectory()).toBe(true);
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("supports interactive prompts when options are omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-cli-init-interactive-"));

    try {
      const vaultPath = join(root, "vault");
      await mkdir(vaultPath, { recursive: true });

      const answers = [
        vaultPath,
        "Research",
        "777",
        "ZOTERO_API_KEY",
        "prompt@example.com",
        "04:00-06:00,17:00-19:00",
        "Europe/Oslo",
      ];

      const result = await runInitCommand(
        {},
        {
          cwd: root,
          prompt: async () => {
            const next = answers.shift();
            if (!next) {
              throw new Error("Unexpected prompt call");
            }
            return next;
          },
        },
      );

      const configContent = await Bun.file(result.configPath).text();
      const parsed = parseAndValidateConfig(configContent, {
        ZOTERO_API_KEY: "secret",
      });

      expect(parsed.zotero.user_id).toBe("777");
      expect(parsed.pdf.unpaywall_email).toBe("prompt@example.com");
      expect(parsed.ai.windows).toEqual(["04:00-06:00", "17:00-19:00"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
