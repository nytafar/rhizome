import { mkdir, mkdtemp, rm, copyFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/db/database";
import { runInitCommand } from "../../src/cli/commands/init";
import { runSyncZoteroCommand } from "../../src/cli/commands/sync";
import { runProcessCommand } from "../../src/cli/commands/process";
import { runStatusCommand } from "../../src/cli/commands/status";
import { runLockClearCommand, runLockStatusCommand } from "../../src/cli/commands/lock";
import { PipelineStep } from "../../src/types/pipeline";
import { runLivePreflight } from "../../tests/e2e/support/live-preflight";
import { captureSummarizeFailureEvidence } from "../../tests/e2e/support/evidence";
import type {
  EvidenceCommandRecord,
  EvidenceDbSnapshot,
  EvidenceLockDiagnostics,
  EvidenceStudyArtifactCheck,
  IntelligenceLoopEvidenceBundle,
  IntelligenceLoopEvidenceSummary,
} from "./evidence-types";

const EVIDENCE_DIR = ".gsd/milestones/M001/slices/S05/evidence/latest";
const SUMMARY_JSON_PATH = join(EVIDENCE_DIR, "summary.json");
const BUNDLE_JSON_PATH = join(EVIDENCE_DIR, "bundle.json");
const REPORT_MD_PATH = join(EVIDENCE_DIR, "report.md");
const DEBUG_DIR_PATH = join(EVIDENCE_DIR, "debug");

const SUMMARIZER_SKILL = `You are a structured study summarizer.
Return JSON that strictly matches the provided schema.
Keep each field concise and factual.
If only abstract text is available, set source to "abstract_only".`;

function writerBuffer() {
  const chunks: string[] = [];
  return {
    writer: {
      write(chunk: string | Uint8Array): boolean {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      },
    },
    flush(): string {
      return chunks.join("");
    },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCommand<T>(params: {
  name: string;
  argv: string[];
  invoke: (stdout: Pick<typeof process.stdout, "write">) => Promise<T>;
}): Promise<EvidenceCommandRecord<T>> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const capture = writerBuffer();

  try {
    const result = await params.invoke(capture.writer);
    const completedAtMs = Date.now();

    return {
      name: params.name,
      argv: params.argv,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      ok: true,
      stdout: capture.flush(),
      result,
    };
  } catch (error) {
    const completedAtMs = Date.now();

    return {
      name: params.name,
      argv: params.argv,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      ok: false,
      stdout: capture.flush(),
      errorMessage: toErrorMessage(error),
    };
  }
}

async function captureDbSnapshot(dbPath: string): Promise<EvidenceDbSnapshot | undefined> {
  if (!(await Bun.file(dbPath).exists())) {
    return undefined;
  }

  const database = new Database({ path: dbPath });
  database.init();

  try {
    const studies = database.db
      .query(
        `
          SELECT siss_id, citekey, title, pipeline_overall, pipeline_error, pipeline_steps_json
          FROM studies
          ORDER BY citekey ASC;
        `,
      )
      .all() as EvidenceDbSnapshot["studies"];

    const jobs = database.db
      .query(
        `
          SELECT id, siss_id, stage, status, retry_count, error_message, completed_at
          FROM jobs
          ORDER BY id ASC;
        `,
      )
      .all() as EvidenceDbSnapshot["jobs"];

    const summarizeRows = database.db
      .query(
        `
          SELECT status, COUNT(*) AS count
          FROM jobs
          WHERE stage = ?
          GROUP BY status
          ORDER BY status ASC;
        `,
      )
      .all(PipelineStep.SUMMARIZE) as Array<{ status: string; count: number }>;

    return {
      generatedAt: new Date().toISOString(),
      studies,
      jobs,
      summarizeStatuses: Object.fromEntries(
        summarizeRows.map((row) => [row.status, Number(row.count)] as const),
      ),
    };
  } finally {
    database.close();
  }
}

async function copyFailureEvidence(params: {
  sourceManifestPath: string;
  sourceDebugPaths: string[];
}): Promise<{ copiedManifestPath?: string; copiedDebugPaths: string[] }> {
  await mkdir(DEBUG_DIR_PATH, { recursive: true });

  const copiedDebugPaths: string[] = [];
  const manifestTarget = join(DEBUG_DIR_PATH, "summarize-failure-manifest.json");

  if (await Bun.file(params.sourceManifestPath).exists()) {
    await copyFile(params.sourceManifestPath, manifestTarget);
  }

  for (const sourcePath of params.sourceDebugPaths) {
    if (!(await Bun.file(sourcePath).exists())) {
      continue;
    }

    const target = join(DEBUG_DIR_PATH, basename(sourcePath));
    await copyFile(sourcePath, target);
    copiedDebugPaths.push(target);
  }

  return {
    copiedManifestPath: (await Bun.file(manifestTarget).exists()) ? manifestTarget : undefined,
    copiedDebugPaths,
  };
}

async function createReport(bundle: IntelligenceLoopEvidenceBundle): Promise<string> {
  const commandRows = bundle.commands
    .map(
      (command, index) =>
        `| ${index + 1} | ${command.argv.join(" ")} | ${command.ok ? "✅ pass" : "❌ fail"} | ${command.durationMs} |`,
    )
    .join("\n");

  const studyRows = bundle.studyArtifactChecks
    .map(
      (item) =>
        `| ${item.citekey} | ${item.noteExists ? "✅" : "❌"} | ${item.summaryExists ? "✅" : "❌"} |`,
    )
    .join("\n");

  const summarizeStatuses = bundle.dbSnapshot
    ? Object.entries(bundle.dbSnapshot.summarizeStatuses).length > 0
      ? Object.entries(bundle.dbSnapshot.summarizeStatuses)
          .map(([status, count]) => `- ${status}: ${count}`)
          .join("\n")
      : "- <none>"
    : "- <no snapshot>";

  return [
    "# Intelligence Loop Evidence (S06/T02)",
    "",
    `- Generated at: ${bundle.generatedAt}`,
    `- Outcome: ${bundle.outcome}`,
    `- Preflight: ${bundle.preflight.ok ? "ready" : `skipped (${bundle.preflight.reason})`}`,
    `- Workspace: ${bundle.workspace.root || "<not-created>"}`,
    `- Bundle JSON: ${bundle.deterministicPaths.bundleJson}`,
    "",
    "## Commands",
    "",
    "| # | Command | Verdict | Duration (ms) |",
    "|---|---------|---------|---------------|",
    commandRows || "| - | <none> | - | - |",
    "",
    "## DB summarize statuses",
    "",
    summarizeStatuses,
    "",
    "## Study artifact checks",
    "",
    "| Citekey | Note exists | Summary exists |",
    "|---------|-------------|----------------|",
    studyRows || "| <none> | - | - |",
    "",
    "## Lock diagnostics",
    "",
    bundle.lockDiagnostics
      ? [
          `- fixture path: ${bundle.lockDiagnostics.fixturePath}`,
          `- fixture created: ${bundle.lockDiagnostics.fixtureCreated}`,
          `- lock status before clear: ${bundle.lockDiagnostics.before.ok ? "ok" : "error"}`,
          `- clear --force: ${bundle.lockDiagnostics.forcedClear.ok ? "ok" : "error"}`,
          `- lock status after clear: ${bundle.lockDiagnostics.after.ok ? "ok" : "error"}`,
        ].join("\n")
      : "- <not captured>",
    "",
    "## Failure",
    "",
    bundle.failure ? `- ${bundle.failure.step ?? "runtime"}: ${bundle.failure.message}` : "- none",
    "",
  ].join("\n");
}

async function clearEvidenceDir(): Promise<void> {
  await rm(EVIDENCE_DIR, { recursive: true, force: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });
}

async function main(): Promise<void> {
  await clearEvidenceDir();

  const preflight = await runLivePreflight();

  const bundle: IntelligenceLoopEvidenceBundle = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    outcome: "skip",
    deterministicPaths: {
      dir: EVIDENCE_DIR,
      summaryJson: SUMMARY_JSON_PATH,
      bundleJson: BUNDLE_JSON_PATH,
      reportMd: REPORT_MD_PATH,
      debugDir: DEBUG_DIR_PATH,
    },
    preflight,
    workspace: {
      root: "",
      vaultPath: "",
      dbPath: "",
      cleanedUp: false,
    },
    commands: [],
    statusDetails: [],
    studyArtifactChecks: [],
    debugEvidence: {
      captured: false,
      copiedDebugPaths: [],
      rawDebugPaths: [],
    },
    summary: {
      studiesCount: 0,
      summarizeCompleteCount: 0,
      failedCommands: [],
      skipReason: preflight.ok ? undefined : preflight.reason,
    },
  };

  let workspaceRoot = "";
  let workspaceVault = "";
  let workspaceDbPath = "";

  workspaceRoot = await mkdtemp(join(tmpdir(), "rhizome-intelligence-evidence-"));
    workspaceVault = join(workspaceRoot, "vault");
    workspaceDbPath = join(workspaceRoot, ".siss", "siss.db");

    bundle.workspace.root = workspaceRoot;
    bundle.workspace.vaultPath = workspaceVault;
    bundle.workspace.dbPath = workspaceDbPath;

    await mkdir(workspaceVault, { recursive: true });

    const initRecord = await runCommand({
      name: "init",
      argv: [
        "rhizome",
        "init",
        "--non-interactive",
        "--force",
        `--vault=${workspaceVault}`,
        "--research-root=Research",
      ],
      invoke: (stdout) =>
        runInitCommand(
          {
            nonInteractive: true,
            force: true,
            vault: workspaceVault,
            researchRoot: "Research",
            zoteroUser: process.env.RHIZOME_E2E_ZOTERO_USER ?? "0",
            zoteroKeyEnv: "ZOTERO_API_KEY",
            unpaywallEmail: "e2e@example.com",
            aiWindows: "00:00-23:59",
            timezone: "UTC",
          },
          { cwd: workspaceRoot, stdout },
        ),
    });
    bundle.commands.push(initRecord);

    if (initRecord.ok) {
      const skillPath = join(workspaceRoot, ".siss", "skills", "summarizer.md");
      await Bun.write(skillPath, SUMMARIZER_SKILL);
    } else {
      bundle.failure = { step: "init", message: initRecord.errorMessage ?? "init failed" };
    }

    if (!bundle.failure && preflight.ok) {
      const syncRecord = await runCommand({
        name: "sync",
        argv: [
          "rhizome",
          "sync",
          "zotero",
          "--full",
          `--collection=${process.env.RHIZOME_E2E_ZOTERO_COLLECTION ?? ""}`,
        ],
        invoke: (stdout) =>
          runSyncZoteroCommand(
            {
              full: true,
              collection: [process.env.RHIZOME_E2E_ZOTERO_COLLECTION as string],
            },
            { cwd: workspaceRoot, stdout },
          ),
      });
      bundle.commands.push(syncRecord);

      if (!syncRecord.ok) {
        bundle.failure = { step: "sync", message: syncRecord.errorMessage ?? "sync failed" };
      }
    }

    if (!bundle.failure && preflight.ok) {
      const processRecord = await runCommand({
        name: "process-ai",
        argv: ["rhizome", "process", "--ai"],
        invoke: (stdout) => runProcessCommand({ ai: true }, { cwd: workspaceRoot, stdout }),
      });
      bundle.commands.push(processRecord);

      if (!processRecord.ok) {
        bundle.failure = { step: "process", message: processRecord.errorMessage ?? "process failed" };
      } else if ((processRecord.result?.result.failed ?? 0) !== 0) {
        bundle.failure = {
          step: "process",
          message: `process reported failed=${processRecord.result?.result.failed}`,
        };
      }
    }

    const statusOverview = await runCommand({
      name: "status-overview",
      argv: ["rhizome", "status", "--json"],
      invoke: (stdout) => runStatusCommand({ json: true }, { cwd: workspaceRoot, stdout }),
    });
    bundle.commands.push(statusOverview);
    bundle.statusOverview = statusOverview;

    if (!statusOverview.ok && !bundle.failure) {
      bundle.failure = {
        step: "status-overview",
        message: statusOverview.errorMessage ?? "status overview failed",
      };
    }

    bundle.dbSnapshot = await captureDbSnapshot(workspaceDbPath);

    const studies = bundle.dbSnapshot?.studies ?? [];
    for (const study of studies) {
      const notePath = join(workspaceVault, "Research", "studies", `${study.citekey}.md`);
      const summaryPath = join(
        workspaceVault,
        "Research",
        "studies",
        "_assets",
        study.citekey,
        "summary.current.md",
      );

      const artifactCheck: EvidenceStudyArtifactCheck = {
        citekey: study.citekey,
        notePath,
        noteExists: await Bun.file(notePath).exists(),
        summaryPath,
        summaryExists: await Bun.file(summaryPath).exists(),
      };

      bundle.studyArtifactChecks.push(artifactCheck);

      const detailRecord = await runCommand({
        name: `status-detail:${study.citekey}`,
        argv: ["rhizome", "status", `--citekey=${study.citekey}`, "--json"],
        invoke: (stdout) =>
          runStatusCommand({ citekey: study.citekey, json: true }, { cwd: workspaceRoot, stdout }),
      });

      bundle.commands.push(detailRecord);
      bundle.statusDetails.push(detailRecord);

      if (!detailRecord.ok && !bundle.failure) {
        bundle.failure = {
          step: `status-detail:${study.citekey}`,
          message: detailRecord.errorMessage ?? "status detail failed",
        };
      }
    }

    const lockBefore = await runCommand({
      name: "lock-status:before",
      argv: ["rhizome", "lock", "status", "--json"],
      invoke: (stdout) => runLockStatusCommand({ json: true }, { cwd: workspaceRoot, stdout }),
    });
    bundle.commands.push(lockBefore);

    const fixturePath =
      lockBefore.ok && lockBefore.result && typeof lockBefore.result === "object" && "lockPath" in lockBefore.result
        ? String((lockBefore.result as { lockPath: string }).lockPath)
        : join(workspaceRoot, ".siss", "locks", "mutator.lock");

    await mkdir(join(workspaceRoot, ".siss", "locks"), { recursive: true });

    const fixturePayload = {
      pid: 999999,
      command: "rhizome process --ai",
      acquired_at: new Date(Date.now() - 60_000).toISOString(),
      heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
    };

    await writeFile(fixturePath, `${JSON.stringify(fixturePayload, null, 2)}\n`, "utf8");

    const lockClear = await runCommand({
      name: "lock-clear-force",
      argv: ["rhizome", "lock", "clear", "--force", "--json"],
      invoke: (stdout) => runLockClearCommand({ force: true, json: true }, { cwd: workspaceRoot, stdout }),
    });
    bundle.commands.push(lockClear);

    const lockAfter = await runCommand({
      name: "lock-status:after",
      argv: ["rhizome", "lock", "status", "--json"],
      invoke: (stdout) => runLockStatusCommand({ json: true }, { cwd: workspaceRoot, stdout }),
    });
    bundle.commands.push(lockAfter);

    const lockDiagnostics: EvidenceLockDiagnostics = {
      before: lockBefore,
      fixturePath,
      fixtureCreated: true,
      forcedClear: lockClear,
      after: lockAfter,
    };
    bundle.lockDiagnostics = lockDiagnostics;

    if ((!lockBefore.ok || !lockClear.ok || !lockAfter.ok) && !bundle.failure) {
      bundle.failure = {
        step: "lock-diagnostics",
        message: "lock diagnostics command failed",
      };
    }

  if (bundle.failure || (preflight.ok && bundle.commands.some((command) => !command.ok))) {
    bundle.outcome = "failure";
  } else if (preflight.ok) {
    bundle.outcome = "pass";
  } else {
    bundle.outcome = "skip";
  }

  if (workspaceRoot && (bundle.failure || bundle.outcome === "failure")) {
    const failureEvidence = await captureSummarizeFailureEvidence(workspaceRoot);
    if (failureEvidence) {
      bundle.debugEvidence.captured = true;
      bundle.debugEvidence.sourceManifestPath = failureEvidence.manifestPath;
      bundle.debugEvidence.rawDebugPaths = failureEvidence.debugPaths;

      const copied = await copyFailureEvidence({
        sourceManifestPath: failureEvidence.manifestPath,
        sourceDebugPaths: failureEvidence.debugPaths,
      });
      bundle.debugEvidence.copiedManifestPath = copied.copiedManifestPath;
      bundle.debugEvidence.copiedDebugPaths = copied.copiedDebugPaths;
    }
  }

  bundle.summary.studiesCount = bundle.dbSnapshot?.studies.length ?? 0;
  bundle.summary.summarizeCompleteCount = bundle.dbSnapshot?.summarizeStatuses.complete ?? 0;
  bundle.summary.failedCommands = bundle.commands.filter((command) => !command.ok).map((command) => command.name);
  if (bundle.outcome === "skip") {
    bundle.summary.skipReason = preflight.reason;
  }

  const summaryReason =
    bundle.outcome === "pass"
      ? "end-to-end flow succeeded"
      : bundle.outcome === "skip"
        ? preflight.reason
        : bundle.failure?.message ?? "one or more command checks failed";

  const summary: IntelligenceLoopEvidenceSummary = {
    generatedAt: bundle.generatedAt,
    outcome: bundle.outcome,
    reason: summaryReason,
    bundleJsonPath: BUNDLE_JSON_PATH,
    reportPath: REPORT_MD_PATH,
    studiesCount: bundle.summary.studiesCount,
    summarizeCompleteCount: bundle.summary.summarizeCompleteCount,
    lockDiagnosticsIncluded: Boolean(bundle.lockDiagnostics),
  };

  const report = await createReport(bundle);

  await Bun.write(BUNDLE_JSON_PATH, `${JSON.stringify(bundle, null, 2)}\n`);
  await Bun.write(SUMMARY_JSON_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  await Bun.write(REPORT_MD_PATH, report);

  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
    bundle.workspace.cleanedUp = true;

    // keep persisted bundle authoritative after cleanup flag update
    await Bun.write(BUNDLE_JSON_PATH, `${JSON.stringify(bundle, null, 2)}\n`);
  }

  console.log(`Evidence bundle directory: ${EVIDENCE_DIR}`);
  console.log(`Summary JSON: ${SUMMARY_JSON_PATH}`);
  console.log(`Bundle JSON: ${BUNDLE_JSON_PATH}`);
  console.log(`Report: ${REPORT_MD_PATH}`);
  console.log(`Outcome: ${bundle.outcome}`);

  if (bundle.outcome === "failure") {
    process.exitCode = 1;
  }
}

await main();
