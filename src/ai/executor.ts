import { mkdirSync } from "node:fs";

export interface ClaudeCodeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface InvokeClaudeCodeOptions {
  claudeBinary?: string;
  systemPromptFile: string;
  jsonSchema: unknown;
  maxTurns: number;
  timeoutMs: number;
  input: string;
  promptText?: string;
  tools?: string[];
  debugDir?: string;
  spawn?: typeof Bun.spawn;
}

export class ClaudeCodeInvocationError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly debugPath?: string;

  constructor(
    message: string,
    result: ClaudeCodeResult,
    debugPath?: string,
    cause?: unknown,
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "ClaudeCodeInvocationError";
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.durationMs = result.durationMs;
    this.debugPath = debugPath;
  }
}

type ClaudeResultEnvelope = {
  type?: unknown;
  is_error?: unknown;
  result?: unknown;
};

async function persistDebugFailure(params: {
  debugDir: string;
  reason: string;
  result: ClaudeCodeResult;
}): Promise<string> {
  mkdirSync(params.debugDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const path = `${params.debugDir}/claude-executor-${stamp}.txt`;
  const payload = [
    `reason: ${params.reason}`,
    `exitCode: ${params.result.exitCode}`,
    `durationMs: ${params.result.durationMs}`,
    `stderr:\n${params.result.stderr || "<empty>"}`,
    `stdout:\n${params.result.stdout || "<empty>"}`,
  ].join("\n\n");

  await Bun.write(path, payload);
  return path;
}

export async function invokeClaudeCode(
  options: InvokeClaudeCodeOptions,
): Promise<ClaudeCodeResult> {
  const spawn = options.spawn ?? Bun.spawn;
  const startedAt = performance.now();

  const proc = spawn(
    [
      options.claudeBinary ?? "claude",
      "-p",
      "--system-prompt-file",
      options.systemPromptFile,
      "--json-schema",
      JSON.stringify(options.jsonSchema),
      "--output-format",
      "json",
      "--max-turns",
      String(options.maxTurns),
      "--bare",
      "--tools",
      (options.tools ?? ["Read"]).join(","),
      options.promptText ?? "Process this study according to your instructions.",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs,
    },
  );

  proc.stdin.write(options.input);
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const result: ClaudeCodeResult = {
    exitCode,
    stdout,
    stderr,
    durationMs: Math.round(performance.now() - startedAt),
  };

  if (exitCode !== 0) {
    const debugPath = await persistDebugFailure({
      debugDir: options.debugDir ?? "debug",
      reason: "non_zero_exit",
      result,
    });
    throw new ClaudeCodeInvocationError(
      `Claude invocation failed with exit code ${exitCode}. Debug: ${debugPath}`,
      result,
      debugPath,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const debugPath = await persistDebugFailure({
      debugDir: options.debugDir ?? "debug",
      reason: "non_json_stdout",
      result,
    });
    throw new ClaudeCodeInvocationError(
      `Claude returned non-JSON stdout. Debug: ${debugPath}`,
      result,
      debugPath,
      error,
    );
  }

  const envelope = parsed as ClaudeResultEnvelope;
  if (envelope.type === "result" && envelope.is_error === true) {
    const debugPath = await persistDebugFailure({
      debugDir: options.debugDir ?? "debug",
      reason: "claude_result_error_envelope",
      result,
    });
    throw new ClaudeCodeInvocationError(
      `Claude returned an error envelope. Debug: ${debugPath}`,
      result,
      debugPath,
    );
  }

  return result;
}
