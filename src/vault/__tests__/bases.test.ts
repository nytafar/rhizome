import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RhizomeConfig } from "../../config/schema";
import {
  BASE_ARTIFACT_NAMES,
  BasePersistenceError,
  renderBasesArtifacts,
  resolveBasesSystemDir,
  writeBasesArtifacts,
} from "../bases";

function makeVaultConfig(root: string): Pick<RhizomeConfig, "vault"> {
  return {
    vault: {
      path: root,
      research_root: "Research",
      studies_folder: "studies",
      assets_folder: "_assets",
      study_notes_folder: "study-notes",
      imports_folder: "_imports",
      system_folder: "_system",
    },
  };
}

describe("vault bases", () => {
  test("renders deterministic base YAML with required sections", () => {
    const first = renderBasesArtifacts();
    const second = renderBasesArtifacts();

    expect(second).toEqual(first);

    for (const artifact of BASE_ARTIFACT_NAMES) {
      const content = first[artifact];
      expect(content).toContain("views:");
      expect(content).toContain("order:");
      expect(content.length).toBeGreaterThan(20);
    }

    expect(first["studies.base"]).toContain("pipeline_status");
    expect(first["fulltexts.base"]).toContain('has_fulltext == true');
    expect(first["review-queue.base"]).toContain("pipeline_error");
  });

  test("resolves _system base output path from config", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-bases-path-"));

    try {
      const config = makeVaultConfig(root);
      const systemDir = resolveBasesSystemDir(config);

      expect(systemDir).toBe(join(root, "Research", "_system"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes all base artifacts atomically and deterministically across reruns", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-bases-write-"));

    try {
      const config = makeVaultConfig(root);
      const first = await writeBasesArtifacts(config);

      expect(first.files).toHaveLength(3);
      expect(first.systemDir).toBe(join(root, "Research", "_system"));

      const firstContent = Object.fromEntries(
        await Promise.all(
          first.files.map(async (path) => [path, await readFile(path, "utf8")]),
        ),
      );

      const second = await writeBasesArtifacts(config);
      const secondContent = Object.fromEntries(
        await Promise.all(
          second.files.map(async (path) => [path, await readFile(path, "utf8")]),
        ),
      );

      expect(secondContent).toEqual(firstContent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed path segments and does not proceed to write", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-bases-invalid-"));

    try {
      const config = makeVaultConfig(root);
      config.vault.system_folder = "../escape";

      await expect(writeBasesArtifacts(config)).rejects.toBeInstanceOf(BasePersistenceError);
      await expect(writeBasesArtifacts(config)).rejects.toThrow(
        "vault.system_folder must not contain path separators",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves existing files when rename fails and surfaces actionable diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-bases-rename-fail-"));

    try {
      const config = makeVaultConfig(root);
      const systemDir = resolveBasesSystemDir(config);
      await mkdir(systemDir, { recursive: true });

      const studiesPath = join(systemDir, "studies.base");
      const original = "original-content\n";
      await writeFile(studiesPath, original, "utf8");

      let renameAttempts = 0;
      await expect(
        writeBasesArtifacts(config, {
          fs: {
            mkdir,
            writeFile,
            rename: async (from, to) => {
              renameAttempts += 1;
              if (renameAttempts === 1) {
                throw new Error("simulated rename failure");
              }
              await rename(from, to);
            },
            rm,
          },
        }),
      ).rejects.toThrow("[bases:rename] studies.base");

      const after = await readFile(studiesPath, "utf8");
      expect(after).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
