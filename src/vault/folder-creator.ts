import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RhizomeConfig } from "../config/schema";

type VaultConfig = RhizomeConfig["vault"];

export interface EnsureVaultFolderStructureInput {
  vaultPath: string;
  vault: VaultConfig;
  importSources?: string[];
}

export interface VaultFolderStructureResult {
  researchRootDir: string;
  ensuredDirs: string[];
}

const DEFAULT_IMPORT_SOURCES = ["bibtex", "researchrabbit", "litmaps"];

function uniqueDirs(dirs: string[]): string[] {
  return Array.from(new Set(dirs));
}

export function getVaultFolderStructurePaths(
  input: EnsureVaultFolderStructureInput,
): VaultFolderStructureResult {
  const researchRootDir = join(input.vaultPath, input.vault.research_root);

  const studiesDir = join(researchRootDir, input.vault.studies_folder);
  const assetsDir = join(studiesDir, input.vault.assets_folder);
  const studyNotesDir = join(researchRootDir, input.vault.study_notes_folder);
  const importsDir = join(researchRootDir, input.vault.imports_folder);
  const systemDir = join(researchRootDir, input.vault.system_folder);

  const importSources = input.importSources ?? DEFAULT_IMPORT_SOURCES;
  const importDoneDirs = importSources.map((source) =>
    join(importsDir, source, "done"),
  );

  const ensuredDirs = uniqueDirs([
    researchRootDir,
    studiesDir,
    assetsDir,
    studyNotesDir,
    importsDir,
    ...importDoneDirs,
    systemDir,
  ]);

  return {
    researchRootDir,
    ensuredDirs,
  };
}

export async function ensureVaultFolderStructure(
  input: EnsureVaultFolderStructureInput,
): Promise<VaultFolderStructureResult> {
  const paths = getVaultFolderStructurePaths(input);

  await Promise.all(paths.ensuredDirs.map((dir) => mkdir(dir, { recursive: true })));

  return paths;
}
