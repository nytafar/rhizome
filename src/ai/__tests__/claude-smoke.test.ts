import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

type SmokeResponse = {
  status: string;
};

type ClaudeResultEnvelope = {
  type?: unknown;
  is_error?: unknown;
  result?: unknown;
};

type SmokeRun = {
  run: number;
  exitCode: number;
  durationMs: number;
  stderr: string;
  parsed: SmokeResponse;
};

const SMOKE_SCHEMA = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { type: "string" },
  },
} as const;

const SAMPLE_INPUT = `# Study Metadata
Title: Smoke Test Study
Year: 2026

# Abstract
This is a contract smoke test input.`;

function resolveClaudeEnv(): Record<string, string | undefined> {
  const userHome = process.env.HOME ?? homedir();
  return {
    ...process.env,
    HOME: userHome,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? `${userHome}/.config`,
  };
}

async function persistDebugFailure(params: {
  run: number;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  reason: string;
}): Promise<string> {
  mkdirSync("debug", { recursive: true });

  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const path = `debug/claude-smoke-run${params.run}-${stamp}.txt`;
  const payload = [
    `reason: ${params.reason}`,
    `run: ${params.run}`,
    `exitCode: ${params.exitCode}`,
    `durationMs: ${params.durationMs}`,
    `stderr:\n${params.stderr || "<empty>"}`,
    `stdout:\n${params.stdout || "<empty>"}`,
  ].join("\n\n");

  await Bun.write(path, payload);
  return path;
}

async function runSmokeInvocation(run: number): Promise<SmokeRun> {
  const startedAt = performance.now();
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--json-schema",
      JSON.stringify(SMOKE_SCHEMA),
      "--output-format",
      "json",
      "--tools",
      "Read",
      `Return JSON with status exactly \"smoke_ok_run_${run}\".`,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: resolveClaudeEnv(),
    },
  );

  proc.stdin.write(SAMPLE_INPUT);
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const durationMs = Math.round(performance.now() - startedAt);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const debugPath = await persistDebugFailure({
      run,
      exitCode,
      durationMs,
      stdout,
      stderr,
      reason: "non_json_stdout",
    });

    throw new Error(
      [
        `Run ${run} produced non-JSON stdout (debug: ${debugPath}).`,
        `Exit code: ${exitCode}`,
        `parseError: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
    );
  }

  const envelope = parsed as ClaudeResultEnvelope;
  if (envelope.type === "result" && envelope.is_error === true) {
    const debugPath = await persistDebugFailure({
      run,
      exitCode,
      durationMs,
      stdout,
      stderr,
      reason: "claude_result_error_envelope",
    });

    throw new Error(
      [
        `Run ${run} returned Claude error envelope (debug: ${debugPath}).`,
        `Exit code: ${exitCode}`,
        `result: ${typeof envelope.result === "string" ? envelope.result : "<non-string>"}`,
      ].join("\n"),
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { status?: unknown }).status !== "string"
  ) {
    const debugPath = await persistDebugFailure({
      run,
      exitCode,
      durationMs,
      stdout,
      stderr,
      reason: "unexpected_json_shape",
    });

    throw new Error(
      [
        `Run ${run} returned JSON with unexpected shape (debug: ${debugPath}).`,
        `Exit code: ${exitCode}`,
      ].join("\n"),
    );
  }

  return {
    run,
    exitCode,
    durationMs,
    stderr,
    parsed: parsed as SmokeResponse,
  };
}

describe("Claude CLI invocation contract smoke", () => {
  test(
    "runs 3 times with JSON-schema constrained output",
    async () => {
      if (process.env.RHIZOME_ENABLE_REAL_CLAUDE_SMOKE !== "1") {
        console.info(
          "[claude-smoke] skipped (set RHIZOME_ENABLE_REAL_CLAUDE_SMOKE=1 to run real Claude invocation)",
        );
        return;
      }

      const claudeBinary = Bun.which("claude");
      if (!claudeBinary) {
        throw new Error("'claude' binary not found in PATH.");
      }

      const runs: SmokeRun[] = [];
      for (let run = 1; run <= 3; run += 1) {
        const result = await runSmokeInvocation(run);
        runs.push(result);

        expect(result.exitCode).toBe(0);
        expect(result.parsed.status).toBe(`smoke_ok_run_${run}`);
      }

      const durationSummary = runs
        .map((r) => `run=${r.run} durationMs=${r.durationMs} exitCode=${r.exitCode}`)
        .join(" | ");

      const stderrSummary = runs
        .map((r) =>
          r.stderr.trim().length === 0
            ? `run=${r.run} stderr=<empty>`
            : `run=${r.run} stderr=${r.stderr.trim()}`,
        )
        .join(" | ");

      console.info(`[claude-smoke] ${durationSummary}`);
      console.info(`[claude-smoke] ${stderrSummary}`);
    },
    120_000,
  );
});
