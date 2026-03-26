type ClaudeResultEnvelope = {
  type?: unknown;
  is_error?: unknown;
  result?: unknown;
};

export interface LivePreflightResult {
  ok: boolean;
  reason: string;
  claudeBinary?: string;
}

export interface LivePreflightOptions {
  env?: NodeJS.ProcessEnv;
  claudeBinary?: string;
  timeoutMs?: number;
  spawn?: typeof Bun.spawn;
}

const REQUIRED_ENV_VARS = [
  "RHIZOME_E2E_ZOTERO_USER",
  "RHIZOME_E2E_ZOTERO_COLLECTION",
  "ZOTERO_API_KEY",
] as const;

const READINESS_SCHEMA = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { type: "string" },
  },
} as const;

function stderrSummary(stderr: string): string {
  const firstLine = stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? "no stderr output";
}

export async function runLivePreflight(
  options: LivePreflightOptions = {},
): Promise<LivePreflightResult> {
  const env = options.env ?? process.env;

  const missing = REQUIRED_ENV_VARS.filter((key) => {
    const value = env[key];
    return typeof value !== "string" || value.trim().length === 0;
  });

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `missing required env vars: ${missing.join(", ")}. Export them before running live E2E.`,
    };
  }

  const claudeBinary = options.claudeBinary ?? Bun.which("claude");
  if (!claudeBinary) {
    return {
      ok: false,
      reason: "'claude' binary not found in PATH. Install Claude CLI before running live E2E.",
    };
  }

  const spawn = options.spawn ?? Bun.spawn;
  const proc = spawn(
    [
      claudeBinary,
      "-p",
      "--json-schema",
      JSON.stringify(READINESS_SCHEMA),
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--bare",
      "--tools",
      "Read",
      'Return JSON with status exactly "ready".',
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 20_000,
    },
  );

  proc.stdin.write("# Readiness Probe\nThis is a preflight probe for live E2E.");
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    return {
      ok: false,
      reason:
        "Claude readiness check failed (likely auth/session/quota). " +
        `Run 'claude login' and verify quota, then retry. stderr: ${stderrSummary(stderr)}`,
      claudeBinary,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      reason:
        "Claude readiness check returned non-JSON output. " +
        `stderr: ${stderrSummary(stderr)}`,
      claudeBinary,
    };
  }

  const envelope = parsed as ClaudeResultEnvelope;
  if (envelope.type === "result" && envelope.is_error === true) {
    const detail = typeof envelope.result === "string" ? envelope.result : "<non-string result>";
    return {
      ok: false,
      reason:
        "Claude readiness check returned an error envelope (likely auth/quota). " +
        `detail: ${detail}`,
      claudeBinary,
    };
  }

  const status =
    typeof parsed === "object" && parsed !== null && "status" in parsed
      ? (parsed as { status?: unknown }).status
      : undefined;

  if (status !== "ready") {
    return {
      ok: false,
      reason: `Claude readiness check returned unexpected status: ${String(status)}.`,
      claudeBinary,
    };
  }

  return {
    ok: true,
    reason: "ready",
    claudeBinary,
  };
}
