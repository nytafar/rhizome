import matter from "gray-matter";
import { CURRENT_CONFIG_VERSION, parseConfig, type RhizomeConfig } from "./schema";
import { DEFAULT_CANONICAL_CONFIG_PATH, resolveWorkspaceConfigPath } from "./workspace-contract";

const ENV_PREFIX = "env:";

export const DEFAULT_CONFIG_TEMPLATE = `# === Meta ===
config_version: 1

# === Vault ===
vault:
  path: "/path/to/vault"
  research_root: "Research"
  studies_folder: "studies"
  assets_folder: "_assets"
  study_notes_folder: "study-notes"
  imports_folder: "_imports"
  system_folder: "_system"

# === Zotero ===
zotero:
  enabled: true
  user_id: "12345"
  api_key: "env:ZOTERO_API_KEY"
  collections: []
  skip_item_types:
    - "note"
    - "attachment"
    - "annotation"
    - "webpage"

# === PDF ===
pdf:
  sources:
    - "zotero"
    - "unpaywall"
    - "europepmc"
  unpaywall_email: "your@email.com"
  download_timeout_ms: 30000
  max_file_size_mb: 100

# === PDF Parser ===
parser:
  active_provider: "marker"
  marker:
    version: "1.6.0"
    timeout_ms: 300000
    force_ocr: false
    python_env: ".siss-env"

# === AI ===
ai:
  windows:
    - "04:00-06:00"
    - "17:00-19:00"
    - "23:00-01:00"
  timezone: "Europe/Oslo"
  batch_size: 20
  cooldown_seconds: 30
  strategy: "piped"
  max_input_tokens: 80000
  claude_binary: "claude"
  summarizer:
    skill_file: "summarizer.md"
    max_turns: 10
    timeout_ms: 300000
  classifier:
    skill_file: "classifier.md"
    max_turns: 5
    timeout_ms: 180000

# === Taxonomy ===
taxonomy:
  auto_promote_threshold: 3
  deprecation_days: 90
  max_pending_before_review: 20
  groups:
    - name: "therapeutic_areas"
      description: "Primary therapeutic/health areas"
    - name: "mechanisms"
      description: "Biological mechanisms of action"
    - name: "indications"
      description: "Clinical or product indications"
    - name: "contraindications"
      description: "Known contraindications"
    - name: "drug_interactions"
      description: "Known drug interactions"
    - name: "research_gaps"
      description: "Identified gaps in research"

# === Pipeline ===
pipeline:
  max_retries: 3
  single_writer: true
  lock_path: ".siss/locks/mutator.lock"
  lock_stale_minutes: 15
  ai_required_stages:
    - "summarize"
    - "classify"
  skip_stages: []

# === Audit ===
audit:
  markdown_log: true
  retain_debug_output: true

# === Data ===
data:
  db_path: ".siss/siss.db"
  skills_dir: ".siss/skills/"
`;

export type EnvMap = Record<string, string | undefined>;

function parseYamlDocument(input: string): unknown {
  const wrapped = `---\n${input}\n---\n`;
  return matter(wrapped).data;
}

export function resolveEnvReferences<T>(value: T, env: EnvMap = process.env): T {
  if (typeof value === "string") {
    if (!value.startsWith(ENV_PREFIX)) {
      return value;
    }

    const envKey = value.slice(ENV_PREFIX.length).trim();
    if (envKey.length === 0) {
      throw new Error("Invalid env reference: missing variable name");
    }

    const resolved = env[envKey];
    if (typeof resolved !== "string") {
      throw new Error(`Missing required environment variable: ${envKey}`);
    }

    return resolved as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvReferences(item, env)) as T;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, objectValue]) => [key, resolveEnvReferences(objectValue, env)],
    );
    return Object.fromEntries(entries) as T;
  }

  return value;
}

export function validateConfigVersion(rawConfig: unknown): void {
  if (!rawConfig || typeof rawConfig !== "object") {
    throw new Error("Invalid config: expected an object root");
  }

  const version = (rawConfig as Record<string, unknown>).config_version;
  if (version !== CURRENT_CONFIG_VERSION) {
    throw new Error(
      `Unsupported config_version: ${String(version)}. Expected ${CURRENT_CONFIG_VERSION}.`,
    );
  }
}

export function parseAndValidateConfig(
  yaml: string,
  env: EnvMap = process.env,
): RhizomeConfig {
  const rawConfig = parseYamlDocument(yaml);
  validateConfigVersion(rawConfig);
  const resolvedConfig = resolveEnvReferences(rawConfig, env);
  return parseConfig(resolvedConfig);
}

export async function loadConfig(
  configPath = DEFAULT_CANONICAL_CONFIG_PATH,
  env: EnvMap = process.env,
): Promise<RhizomeConfig> {
  const yaml = await Bun.file(configPath).text();
  return parseAndValidateConfig(yaml, env);
}

export async function loadWorkspaceConfig(
  cwd = process.cwd(),
  env: EnvMap = process.env,
): Promise<RhizomeConfig> {
  const configPath = await resolveWorkspaceConfigPath(cwd);
  return loadConfig(configPath, env);
}
