import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { Database } from "../../db/database";
import { ensureVaultFolderStructure } from "../../vault/folder-creator";
import { parseAndValidateConfig } from "../../config/loader";

const DEFAULT_RESEARCH_ROOT = "Research";
const DEFAULT_AI_WINDOWS = ["17:00-19:00", "23:00-01:00", "04:00-06:00"];
const DEFAULT_TIMEZONE = "Europe/Oslo";
const DEFAULT_ZOTERO_KEY_ENV = "ZOTERO_API_KEY";
const DEFAULT_UNPAYWALL_EMAIL = "your@email.com";

export interface InitCommandOptions {
  vault?: string;
  researchRoot?: string;
  zoteroUser?: string;
  zoteroKeyEnv?: string;
  zoteroCollections?: string;
  unpaywallEmail?: string;
  aiWindows?: string;
  timezone?: string;
  nonInteractive?: boolean;
  force?: boolean;
}

export interface InitResolvedInput {
  vaultPath: string;
  researchRoot: string;
  zoteroUser: string;
  zoteroKeyEnv: string;
  zoteroCollections: string[];
  unpaywallEmail: string;
  aiWindows: string[];
  timezone: string;
}

export interface InitCommandResult {
  configPath: string;
  dbPath: string;
  ensuredDirs: string[];
  vaultPath: string;
}

export type InitPrompt = (question: string, defaultValue?: string) => Promise<string>;

export interface InitCommandDeps {
  cwd?: string;
  stdout?: Pick<typeof defaultStdout, "write">;
  stdin?: typeof defaultStdin;
  prompt?: InitPrompt;
}

function normalizeCsv(input: string | undefined): string[] {
  if (!input) {
    return [];
  }

  return input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function resolveVaultPath(cwd: string, rawPath: string): string {
  if (isAbsolute(rawPath)) {
    return rawPath;
  }

  return join(cwd, rawPath);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderConfigYaml(input: InitResolvedInput): string {
  const collectionsYaml =
    input.zoteroCollections.length > 0
      ? `\n${input.zoteroCollections
          .map((value) => `    - ${yamlString(value)}`)
          .join("\n")}`
      : " []";

  const windowsYaml = input.aiWindows
    .map((value) => `    - ${yamlString(value)}`)
    .join("\n");

  return `# === Meta ===
config_version: 1

# === Vault ===
vault:
  path: ${yamlString(input.vaultPath)}
  research_root: ${yamlString(input.researchRoot)}
  studies_folder: "studies"
  assets_folder: "_assets"
  study_notes_folder: "study-notes"
  imports_folder: "_imports"
  system_folder: "_system"

# === Zotero ===
zotero:
  enabled: true
  user_id: ${yamlString(input.zoteroUser)}
  api_key: ${yamlString(`env:${input.zoteroKeyEnv}`)}
  collections:${collectionsYaml}
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
  unpaywall_email: ${yamlString(input.unpaywallEmail)}
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
${windowsYaml}
  timezone: ${yamlString(input.timezone)}
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
}

function makeReadlinePrompt(deps: InitCommandDeps): InitPrompt {
  return async (question, defaultValue) => {
    const rl = createInterface({
      input: deps.stdin ?? defaultStdin,
      output: deps.stdout ?? defaultStdout,
    });

    try {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const answer = (await rl.question(`${question}${suffix}: `)).trim();
      if (!answer && defaultValue) {
        return defaultValue;
      }
      return answer;
    } finally {
      rl.close();
    }
  };
}

async function resolveInput(
  options: InitCommandOptions,
  deps: InitCommandDeps,
): Promise<InitResolvedInput> {
  const cwd = deps.cwd ?? process.cwd();
  const prompt = deps.prompt ?? makeReadlinePrompt(deps);

  const ask = async (
    label: string,
    existingValue: string | undefined,
    defaultValue?: string,
  ): Promise<string> => {
    if (existingValue && existingValue.trim().length > 0) {
      return existingValue.trim();
    }

    if (options.nonInteractive) {
      throw new Error(`Missing required option for non-interactive mode: ${label}`);
    }

    const answer = await prompt(label, defaultValue);
    if (!answer.trim()) {
      throw new Error(`Missing value: ${label}`);
    }

    return answer.trim();
  };

  const rawVault = await ask("Vault path", options.vault);
  const resolvedVaultPath = resolveVaultPath(cwd, rawVault);

  const researchRoot = await ask(
    "Research root folder",
    options.researchRoot,
    DEFAULT_RESEARCH_ROOT,
  );

  const zoteroUser = await ask("Zotero user ID", options.zoteroUser);
  const zoteroKeyEnv = await ask(
    "Zotero API key env var",
    options.zoteroKeyEnv,
    DEFAULT_ZOTERO_KEY_ENV,
  );

  const unpaywallEmail = await ask(
    "Unpaywall email",
    options.unpaywallEmail,
    DEFAULT_UNPAYWALL_EMAIL,
  );

  const aiWindowsRaw = await ask(
    "AI windows (comma-separated HH:MM-HH:MM)",
    options.aiWindows,
    DEFAULT_AI_WINDOWS.join(","),
  );

  const timezone = await ask("Timezone", options.timezone, DEFAULT_TIMEZONE);

  const aiWindows = normalizeCsv(aiWindowsRaw);
  if (aiWindows.length === 0) {
    throw new Error("At least one AI window is required.");
  }

  return {
    vaultPath: resolvedVaultPath,
    researchRoot,
    zoteroUser,
    zoteroKeyEnv,
    zoteroCollections: normalizeCsv(options.zoteroCollections),
    unpaywallEmail,
    aiWindows,
    timezone,
  };
}

export async function runInitCommand(
  options: InitCommandOptions,
  deps: InitCommandDeps = {},
): Promise<InitCommandResult> {
  const cwd = deps.cwd ?? process.cwd();
  const output = deps.stdout ?? defaultStdout;

  const input = await resolveInput(options, deps);
  const configYaml = renderConfigYaml(input);

  parseAndValidateConfig(configYaml, {
    ...process.env,
    [input.zoteroKeyEnv]: process.env[input.zoteroKeyEnv] ?? "placeholder",
  });

  const sissDir = join(cwd, ".siss");
  const configPath = join(sissDir, "config.yaml");
  const dbPath = join(cwd, ".siss", "siss.db");

  const configExists = await Bun.file(configPath).exists();
  const dbExists = await Bun.file(dbPath).exists();
  if (!options.force && (configExists || dbExists)) {
    throw new Error(
      "Existing Rhizome setup found (.siss/config.yaml or .siss/siss.db). Re-run with --force to overwrite.",
    );
  }

  await mkdir(sissDir, { recursive: true });
  await mkdir(join(sissDir, "skills"), { recursive: true });
  await mkdir(join(sissDir, "locks"), { recursive: true });
  await mkdir(join(sissDir, "logs"), { recursive: true });
  await mkdir(dirname(dbPath), { recursive: true });

  const { ensuredDirs } = await ensureVaultFolderStructure({
    vaultPath: input.vaultPath,
    vault: {
      path: input.vaultPath,
      research_root: input.researchRoot,
      studies_folder: "studies",
      assets_folder: "_assets",
      study_notes_folder: "study-notes",
      imports_folder: "_imports",
      system_folder: "_system",
    },
  });

  await Bun.write(configPath, configYaml);

  const database = new Database({ path: dbPath });
  database.init();
  database.close();

  output.write(`Initialized Rhizome in ${sissDir}\n`);
  output.write(`Config: ${configPath}\n`);
  output.write(`DB: ${dbPath}\n`);

  return {
    configPath,
    dbPath,
    ensuredDirs,
    vaultPath: input.vaultPath,
  };
}
