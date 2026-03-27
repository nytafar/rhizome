import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { Database } from "../../db/database";
import { ensureVaultFolderStructure } from "../../vault/folder-creator";
import { writeBasesArtifacts } from "../../vault/bases";
import { parseAndValidateConfig } from "../../config/loader";

const DEFAULT_RESEARCH_ROOT = "Research";
const DEFAULT_AI_WINDOWS = ["17:00-19:00", "23:00-01:00", "04:00-06:00"];
const DEFAULT_TIMEZONE = "Europe/Oslo";
const DEFAULT_ZOTERO_KEY_ENV = "ZOTERO_API_KEY";
const DEFAULT_UNPAYWALL_EMAIL = "your@email.com";
const MARKER_BOOTSTRAP_TIMEOUT_MS = 120_000;
const UV_INSTALL_HINT = "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh";

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

export interface InitSubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface InitSubprocessRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export type InitSubprocessRunner = (
  request: InitSubprocessRequest,
) => Promise<InitSubprocessResult>;

export type InitBasesWriter = typeof writeBasesArtifacts;

export interface InitCommandDeps {
  cwd?: string;
  stdout?: Pick<typeof defaultStdout, "write">;
  stdin?: typeof defaultStdin;
  prompt?: InitPrompt;
  runSubprocess?: InitSubprocessRunner;
  writeBasesArtifactsFn?: InitBasesWriter;
}

class InitSubprocessTimeoutError extends Error {
  commandDisplay: string;
  timeoutMs: number;

  constructor(commandDisplay: string, timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms: ${commandDisplay}`);
    this.name = "InitSubprocessTimeoutError";
    this.commandDisplay = commandDisplay;
    this.timeoutMs = timeoutMs;
  }
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

function resolveParserPythonEnv(cwd: string, configuredPath: string): string {
  if (configuredPath.includes("\0")) {
    throw new Error(
      "Invalid parser.marker.python_env path: contains null byte. Update parser.marker.python_env in config.",
    );
  }

  if (isAbsolute(configuredPath)) {
    return configuredPath;
  }

  return join(cwd, configuredPath);
}

function buildCommandDisplay(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function summarizeSubprocessFailure(stdout: string, stderr: string): string {
  const preferred = stderr.trim().length > 0 ? stderr : stdout;
  if (preferred.trim().length === 0) {
    return "";
  }

  const firstLine = preferred
    .trim()
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);

  if (!firstLine) {
    return "";
  }

  const normalized = firstLine.trim().replace(/\s+/g, " ");
  if (normalized.length <= 240) {
    return normalized;
  }

  return `${normalized.slice(0, 237)}...`;
}

async function defaultRunSubprocess(
  request: InitSubprocessRequest,
): Promise<InitSubprocessResult> {
  const { command, args, cwd, timeoutMs } = request;
  const commandDisplay = buildCommandDisplay(command, args);

  let processRef: ReturnType<typeof Bun.spawn>;
  try {
    processRef = Bun.spawn([command, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reason);
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      processRef.kill();
      reject(new InitSubprocessTimeoutError(commandDisplay, timeoutMs));
    }, timeoutMs);

    processRef.exited.finally(() => {
      clearTimeout(timer);
    });
  });

  const exitCode = (await Promise.race([processRef.exited, timeoutPromise])) as number;
  const stdout = await new Response(processRef.stdout).text();
  const stderr = await new Response(processRef.stderr).text();

  return {
    exitCode,
    stdout,
    stderr,
  };
}

async function runBootstrapStep(
  deps: InitCommandDeps,
  step: {
    phase: string;
    command: string;
    args: string[];
    cwd: string;
    remediation: string;
    timeoutHint: string;
  },
): Promise<void> {
  const runner = deps.runSubprocess ?? defaultRunSubprocess;
  const commandDisplay = buildCommandDisplay(step.command, step.args);

  let result: InitSubprocessResult;
  try {
    result = await runner({
      command: step.command,
      args: step.args,
      cwd: step.cwd,
      timeoutMs: MARKER_BOOTSTRAP_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof InitSubprocessTimeoutError) {
      throw new Error(
        `Marker bootstrap timed out during ${step.phase} (${commandDisplay}) after ${error.timeoutMs}ms. ${step.timeoutHint}`,
      );
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Marker bootstrap failed during ${step.phase} (${commandDisplay}). ${step.remediation} (${reason})`,
    );
  }

  if (result.exitCode !== 0) {
    const summary = summarizeSubprocessFailure(result.stdout, result.stderr);
    const summarySuffix = summary.length > 0 ? `: ${summary}` : ".";
    throw new Error(
      `Marker bootstrap failed during ${step.phase} (${commandDisplay}) with exit code ${result.exitCode}${summarySuffix} ${step.remediation}`,
    );
  }
}

async function bootstrapMarkerRuntime(
  deps: InitCommandDeps,
  cwd: string,
  config: { version: string; python_env: string },
): Promise<void> {
  const pythonEnvPath = resolveParserPythonEnv(cwd, config.python_env);
  const markerBinary = join(pythonEnvPath, "bin", "marker_single");
  const pinnedMarkerPackage = `marker-pdf==${config.version}`;

  await runBootstrapStep(deps, {
    phase: "uv availability check",
    command: "uv",
    args: ["--version"],
    cwd,
    remediation: UV_INSTALL_HINT,
    timeoutHint: `${UV_INSTALL_HINT} and rerun 'rhizome init --force'.`,
  });

  await runBootstrapStep(deps, {
    phase: "python environment creation",
    command: "uv",
    args: ["venv", pythonEnvPath, "--python", "3.11"],
    cwd,
    remediation: `Fix the uv venv command and rerun 'rhizome init --force'.`,
    timeoutHint:
      "Retry once package cache/network pressure clears, then rerun 'rhizome init --force'.",
  });

  await runBootstrapStep(deps, {
    phase: "marker package install",
    command: "uv",
    args: ["pip", "install", "--python", pythonEnvPath, pinnedMarkerPackage],
    cwd,
    remediation:
      "Fix package installation/network issues and rerun 'rhizome init --force'.",
    timeoutHint:
      "Retry once package cache/network pressure clears, then rerun 'rhizome init --force'.",
  });

  await runBootstrapStep(deps, {
    phase: "marker healthcheck",
    command: markerBinary,
    args: ["--help"],
    cwd,
    remediation:
      "Marker runtime is unhealthy. Re-run 'rhizome init --force' to reinstall the parser environment.",
    timeoutHint:
      "Healthcheck command hung. Re-run 'rhizome init --force' to rebuild the parser environment.",
  });
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

  const parsedConfig = parseAndValidateConfig(configYaml, {
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

  const basesWriter = deps.writeBasesArtifactsFn ?? writeBasesArtifacts;
  try {
    await basesWriter(parsedConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate Obsidian base artifacts during init: ${message}`);
  }

  await bootstrapMarkerRuntime(deps, cwd, parsedConfig.parser.marker);

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
