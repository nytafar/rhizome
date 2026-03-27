import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAndValidateConfig } from "../../config/loader";
import { getVaultFolderStructurePaths } from "../../vault/folder-creator";
import {
  runInitCommand,
  type InitSubprocessRequest,
  type InitSubprocessResult,
} from "../commands/init";

const SUCCESS_RESULT: InitSubprocessResult = {
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
};

type RunnerStub = (request: InitSubprocessRequest) => Promise<InitSubprocessResult>;

const BASE_ARTIFACT_EXPECTATIONS = [
  {
    fileName: "studies.base",
    anchors: ['filters: \'note_type == "study"\'', "tier_6_taxonomy.therapeutic_areas"],
  },
  {
    fileName: "fulltexts.base",
    anchors: ['filters: \'note_type == "study" && has_fulltext == true\'', 'name: "Fulltexts"'],
  },
  {
    fileName: "review-queue.base",
    anchors: ['name: "Review Queue"', "tier_7_provisional"],
  },
] as const;

function makeInitArgs(vaultPath: string) {
  return {
    nonInteractive: true,
    vault: vaultPath,
    researchRoot: "Research",
    zoteroUser: "12345",
    zoteroKeyEnv: "ZOTERO_API_KEY",
    unpaywallEmail: "test@example.com",
    aiWindows: "17:00-19:00,23:00-01:00",
    timezone: "Europe/Oslo",
    zoteroCollections: "Adaptogens,Clinical Trials",
    force: true,
  } as const;
}

describe("rhizome init", () => {
  test("creates config, sqlite db, folder structure, and bootstraps marker runtime in non-interactive mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-cli-init-"));

    try {
      const vaultPath = join(root, "vault");
      await mkdir(vaultPath, { recursive: true });

      const calls: InitSubprocessRequest[] = [];
      const runner: RunnerStub = async (request) => {
        calls.push(request);
        return SUCCESS_RESULT;
      };

      const result = await runInitCommand(makeInitArgs(vaultPath), {
        cwd: root,
        runSubprocess: runner,
      });

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

      const systemDir = join(vaultPath, "Research", "_system");
      await Promise.all(
        BASE_ARTIFACT_EXPECTATIONS.map(async ({ fileName, anchors }) => {
          const artifactPath = join(systemDir, fileName);
          const artifactStat = await stat(artifactPath);
          expect(artifactStat.isFile()).toBe(true);

          const content = await readFile(artifactPath, "utf8");
          for (const anchor of anchors) {
            expect(content).toContain(anchor);
          }
        }),
      );

      expect(calls).toHaveLength(4);
      expect(calls[0]).toMatchObject({ command: "uv", args: ["--version"], cwd: root });
      expect(calls[1]).toMatchObject({
        command: "uv",
        args: ["venv", join(root, ".siss-env"), "--python", "3.11"],
        cwd: root,
      });
      expect(calls[2]).toMatchObject({
        command: "uv",
        args: ["pip", "install", "--python", join(root, ".siss-env"), "marker-pdf==1.6.0"],
        cwd: root,
      });
      expect(calls[3]).toMatchObject({
        command: join(root, ".siss-env", "bin", "marker_single"),
        args: ["--help"],
        cwd: root,
      });
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
          runSubprocess: async () => SUCCESS_RESULT,
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

  test("fails with actionable remediation when uv is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-cli-init-uv-missing-"));

    try {
      const vaultPath = join(root, "vault");
      await mkdir(vaultPath, { recursive: true });

      await expect(
        runInitCommand(makeInitArgs(vaultPath), {
          cwd: root,
          runSubprocess: async ({ command, args }) => {
            if (command === "uv" && args[0] === "--version") {
              return {
                exitCode: 127,
                stdout: "",
                stderr: "uv: command not found",
              };
            }
            return SUCCESS_RESULT;
          },
        }),
      ).rejects.toThrow("Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails with install phase context when marker package install fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-cli-init-install-fail-"));

    try {
      const vaultPath = join(root, "vault");
      await mkdir(vaultPath, { recursive: true });

      await expect(
        runInitCommand(makeInitArgs(vaultPath), {
          cwd: root,
          runSubprocess: async ({ command, args }) => {
            if (command === "uv" && args[0] === "pip") {
              return {
                exitCode: 1,
                stdout: "",
                stderr: "network timeout while downloading marker",
              };
            }
            return SUCCESS_RESULT;
          },
        }),
      ).rejects.toThrow("marker package install");

      await expect(
        runInitCommand(makeInitArgs(vaultPath), {
          cwd: root,
          runSubprocess: async ({ command, args }) => {
            if (command === "uv" && args[0] === "pip") {
              return {
                exitCode: 1,
                stdout: "",
                stderr: "network timeout while downloading marker",
              };
            }
            return SUCCESS_RESULT;
          },
        }),
      ).rejects.toThrow("Fix package installation/network issues and rerun 'rhizome init --force'.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails with healthcheck remediation when marker binary healthcheck fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-cli-init-healthcheck-fail-"));

    try {
      const vaultPath = join(root, "vault");
      await mkdir(vaultPath, { recursive: true });

      await expect(
        runInitCommand(makeInitArgs(vaultPath), {
          cwd: root,
          runSubprocess: async ({ command, args }) => {
            if (command.endsWith("marker_single") && args[0] === "--help") {
              return {
                exitCode: 2,
                stdout: "",
                stderr: "Traceback: missing model assets",
              };
            }
            return SUCCESS_RESULT;
          },
        }),
      ).rejects.toThrow("Marker runtime is unhealthy. Re-run 'rhizome init --force' to reinstall the parser environment.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes .base artifacts under custom research root _system path", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-cli-init-custom-research-root-"));

    try {
      const vaultPath = join(root, "vault");
      await mkdir(vaultPath, { recursive: true });

      await runInitCommand(
        {
          ...makeInitArgs(vaultPath),
          researchRoot: "LabNotes",
        },
        {
          cwd: root,
          runSubprocess: async () => SUCCESS_RESULT,
        },
      );

      const systemDir = join(vaultPath, "LabNotes", "_system");
      await Promise.all(
        BASE_ARTIFACT_EXPECTATIONS.map(async ({ fileName }) => {
          const artifactPath = join(systemDir, fileName);
          const artifactStat = await stat(artifactPath);
          expect(artifactStat.isFile()).toBe(true);
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rerun with --force refreshes existing .base artifacts deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-cli-init-base-refresh-"));

    try {
      const vaultPath = join(root, "vault");
      await mkdir(vaultPath, { recursive: true });

      await runInitCommand(makeInitArgs(vaultPath), {
        cwd: root,
        runSubprocess: async () => SUCCESS_RESULT,
      });

      const studiesPath = join(vaultPath, "Research", "_system", "studies.base");
      await writeFile(studiesPath, "manually changed\n", "utf8");

      await runInitCommand(makeInitArgs(vaultPath), {
        cwd: root,
        runSubprocess: async () => SUCCESS_RESULT,
      });

      const refreshed = await readFile(studiesPath, "utf8");
      expect(refreshed).toContain('filters: \'note_type == "study"\'');
      expect(refreshed).toContain("tier_6_taxonomy.therapeutic_areas");
      expect(refreshed).not.toContain("manually changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails init with explicit context when base generation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-cli-init-base-failure-"));

    try {
      const vaultPath = join(root, "vault");
      await mkdir(vaultPath, { recursive: true });

      await expect(
        runInitCommand(makeInitArgs(vaultPath), {
          cwd: root,
          runSubprocess: async () => SUCCESS_RESULT,
          writeBasesArtifactsFn: async () => {
            throw new Error("synthetic base write failure");
          },
        }),
      ).rejects.toThrow("Failed to generate Obsidian base artifacts during init: synthetic base write failure");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails in non-interactive mode when required options are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-cli-init-missing-required-"));

    try {
      await expect(
        runInitCommand(
          {
            nonInteractive: true,
          },
          {
            cwd: root,
            runSubprocess: async () => SUCCESS_RESULT,
          },
        ),
      ).rejects.toThrow("Missing required option for non-interactive mode: Vault path");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
