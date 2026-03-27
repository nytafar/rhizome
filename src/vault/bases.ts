import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RhizomeConfig } from "../config/schema";

export const BASE_ARTIFACT_NAMES = [
  "studies.base",
  "fulltexts.base",
  "review-queue.base",
] as const;

export type BaseArtifactName = (typeof BASE_ARTIFACT_NAMES)[number];

type BaseRenderer = () => string;

type AtomicFs = Pick<typeof import("node:fs/promises"), "mkdir" | "writeFile" | "rename" | "rm">;

export interface WriteBasesOptions {
  fs?: AtomicFs;
}

export interface WriteBasesResult {
  systemDir: string;
  files: string[];
}

export class BasePersistenceError extends Error {
  readonly stage: "path" | "render" | "write" | "rename";
  readonly artifact: BaseArtifactName | "all";
  readonly targetPath: string;

  constructor(params: {
    stage: "path" | "render" | "write" | "rename";
    artifact: BaseArtifactName | "all";
    targetPath: string;
    message: string;
  }) {
    super(`[bases:${params.stage}] ${params.artifact} ${params.targetPath}: ${params.message}`);
    this.name = "BasePersistenceError";
    this.stage = params.stage;
    this.artifact = params.artifact;
    this.targetPath = params.targetPath;
  }
}

const DEFAULT_FS: AtomicFs = {
  mkdir,
  writeFile,
  rename,
  rm,
};

function renderStudiesBase(): string {
  return [
    'filters: \'note_type == "study"\'',
    "views:",
    "  - type: table",
    '    name: "Studies"',
    "    order:",
    "      - file.name",
    "      - title",
    "      - year",
    "      - journal",
    "      - pipeline_status",
    "      - has_pdf",
    "      - has_fulltext",
    "      - has_summary",
    "      - has_classification",
    "      - pdf_available",
    "      - tier_4.study_type",
    "      - tier_5.safety_rating",
    "      - tier_6_taxonomy.therapeutic_areas",
    "",
  ].join("\n");
}

function renderFulltextsBase(): string {
  return [
    'filters: \'note_type == "study" && has_fulltext == true\'',
    "views:",
    "  - type: table",
    '    name: "Fulltexts"',
    "    order:",
    "      - file.name",
    "      - title",
    "      - year",
    "      - fulltext",
    "      - pdf",
    "      - pipeline_status",
    "      - pdf_source",
    "",
  ].join("\n");
}

function renderReviewQueueBase(): string {
  return [
    "filters:",
    "  or:",
    "    - 'pipeline_status == \"failed\"'",
    "    - 'has_classification == false'",
    "    - 'pdf_available == false'",
    "views:",
    "  - type: table",
    '    name: "Review Queue"',
    "    order:",
    "      - file.name",
    "      - title",
    "      - pipeline_status",
    "      - pipeline_error",
    "      - pdf_available",
    "      - tier_7_provisional",
    "",
  ].join("\n");
}

const RENDERERS: Record<BaseArtifactName, BaseRenderer> = {
  "studies.base": renderStudiesBase,
  "fulltexts.base": renderFulltextsBase,
  "review-queue.base": renderReviewQueueBase,
};

function ensureValidRootPath(pathValue: string): string {
  const normalized = pathValue.trim();
  if (!normalized) {
    throw new Error("vault.path must be a non-empty path");
  }
  return normalized;
}

function ensureValidPathSegment(segmentName: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${segmentName} must be non-empty`);
  }

  if (normalized === "." || normalized === "..") {
    throw new Error(`${segmentName} cannot be '.' or '..'`);
  }

  if (normalized.includes("/") || normalized.includes("\\")) {
    throw new Error(`${segmentName} must not contain path separators`);
  }

  return normalized;
}

export function resolveBasesSystemDir(config: Pick<RhizomeConfig, "vault">): string {
  try {
    const vaultPath = ensureValidRootPath(config.vault.path);
    const researchRoot = ensureValidPathSegment(
      "vault.research_root",
      config.vault.research_root,
    );
    const systemFolder = ensureValidPathSegment(
      "vault.system_folder",
      config.vault.system_folder,
    );

    return join(vaultPath, researchRoot, systemFolder);
  } catch (error) {
    throw new BasePersistenceError({
      stage: "path",
      artifact: "all",
      targetPath: config.vault.path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function renderBasesArtifacts(): Record<BaseArtifactName, string> {
  const artifacts = {} as Record<BaseArtifactName, string>;

  for (const artifact of BASE_ARTIFACT_NAMES) {
    const content = RENDERERS[artifact]().trimEnd() + "\n";
    if (!content.trim()) {
      throw new BasePersistenceError({
        stage: "render",
        artifact,
        targetPath: artifact,
        message: "Rendered base artifact content is empty",
      });
    }
    artifacts[artifact] = content;
  }

  return artifacts;
}

async function writeAtomic(params: {
  fs: AtomicFs;
  targetPath: string;
  content: string;
  artifact: BaseArtifactName;
}): Promise<void> {
  const tempPath = `${params.targetPath}.tmp`;

  try {
    await params.fs.writeFile(tempPath, params.content, "utf8");
  } catch (error) {
    throw new BasePersistenceError({
      stage: "write",
      artifact: params.artifact,
      targetPath: params.targetPath,
      message: String(error),
    });
  }

  try {
    await params.fs.rename(tempPath, params.targetPath);
  } catch (error) {
    throw new BasePersistenceError({
      stage: "rename",
      artifact: params.artifact,
      targetPath: params.targetPath,
      message: String(error),
    });
  } finally {
    await params.fs.rm(tempPath, { force: true });
  }
}

export async function writeBasesArtifacts(
  config: Pick<RhizomeConfig, "vault">,
  options: WriteBasesOptions = {},
): Promise<WriteBasesResult> {
  const fs = options.fs ?? DEFAULT_FS;
  const systemDir = resolveBasesSystemDir(config);
  const artifacts = renderBasesArtifacts();

  await fs.mkdir(systemDir, { recursive: true });

  const files: string[] = [];
  for (const artifact of BASE_ARTIFACT_NAMES) {
    const targetPath = join(systemDir, artifact);
    await writeAtomic({
      fs,
      targetPath,
      content: artifacts[artifact],
      artifact,
    });
    files.push(targetPath);
  }

  return {
    systemDir,
    files,
  };
}
