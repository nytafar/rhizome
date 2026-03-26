import { join } from "node:path";

export const CANONICAL_WORKSPACE_DIR = ".siss";
export const LEGACY_WORKSPACE_DIR = ".rhizome";
export const CONFIG_FILENAME = "config.yaml";

export const DEFAULT_CANONICAL_CONFIG_PATH = `${CANONICAL_WORKSPACE_DIR}/${CONFIG_FILENAME}`;

export type WorkspaceConfigDiscovery =
  | {
      kind: "canonical";
      workspaceDir: string;
      configPath: string;
    }
  | {
      kind: "legacy";
      workspaceDir: string;
      configPath: string;
      migrationGuidance: string;
    }
  | {
      kind: "missing";
      canonicalConfigPath: string;
      legacyConfigPath: string;
      guidance: string;
    };

function buildMissingGuidance(canonicalConfigPath: string, legacyConfigPath: string): string {
  return [
    "No workspace config found.",
    "Expected one of:",
    `- ${canonicalConfigPath} (canonical)`,
    `- ${legacyConfigPath} (legacy compatibility)`,
    "Run `rhizome init` to create a canonical .siss workspace, or migrate legacy .rhizome/config.yaml to .siss/config.yaml.",
  ].join("\n");
}

export async function discoverWorkspaceConfig(cwd = process.cwd()): Promise<WorkspaceConfigDiscovery> {
  const canonicalConfigPath = join(cwd, CANONICAL_WORKSPACE_DIR, CONFIG_FILENAME);
  if (await Bun.file(canonicalConfigPath).exists()) {
    return {
      kind: "canonical",
      workspaceDir: join(cwd, CANONICAL_WORKSPACE_DIR),
      configPath: canonicalConfigPath,
    };
  }

  const legacyConfigPath = join(cwd, LEGACY_WORKSPACE_DIR, CONFIG_FILENAME);
  if (await Bun.file(legacyConfigPath).exists()) {
    return {
      kind: "legacy",
      workspaceDir: join(cwd, LEGACY_WORKSPACE_DIR),
      configPath: legacyConfigPath,
      migrationGuidance:
        "Using legacy .rhizome/config.yaml compatibility path. Migrate to .siss/config.yaml for canonical workspace behavior.",
    };
  }

  return {
    kind: "missing",
    canonicalConfigPath,
    legacyConfigPath,
    guidance: buildMissingGuidance(canonicalConfigPath, legacyConfigPath),
  };
}

export async function resolveWorkspaceConfigPath(cwd = process.cwd()): Promise<string> {
  const discovered = await discoverWorkspaceConfig(cwd);
  if (discovered.kind === "missing") {
    throw new Error(discovered.guidance);
  }

  return discovered.configPath;
}
