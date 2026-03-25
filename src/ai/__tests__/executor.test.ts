import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeCodeInvocationError,
  invokeClaudeCode,
  type ClaudeCodeResult,
} from "../executor";

function streamFromText(text: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

type SpawnCapture = {
  cmd?: string[];
  options?: {
    stdin?: string;
    stdout?: string;
    stderr?: string;
    timeout?: number;
    env?: Record<string, string | undefined>;
  };
  writtenStdin?: string;
  stdinEnded: boolean;
};

function makeSpawnStub(params: {
  stdout: string;
  stderr?: string;
  exitCode: number;
  capture: SpawnCapture;
}): typeof Bun.spawn {
  return ((cmd: string[], options: {
    timeout?: number;
    env?: Record<string, string | undefined>;
  }) => {
    params.capture.cmd = cmd;
    params.capture.options = options;

    return {
      stdout: streamFromText(params.stdout),
      stderr: streamFromText(params.stderr ?? ""),
      exited: Promise.resolve(params.exitCode),
      stdin: {
        write(input: string) {
          params.capture.writtenStdin = input;
        },
        end() {
          params.capture.stdinEnded = true;
        },
      },
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
}

describe("invokeClaudeCode", () => {
  test("spawns Claude with expected args, pipes stdin, and returns result", async () => {
    const capture: SpawnCapture = { stdinEnded: false };

    const result = await invokeClaudeCode({
      systemPromptFile: ".siss/skills/summarizer.md",
      jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      maxTurns: 10,
      timeoutMs: 12_345,
      input: "study input",
      spawn: makeSpawnStub({
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
        exitCode: 0,
        capture,
      }),
    });

    expect(capture.cmd).toEqual([
      "claude",
      "-p",
      "--system-prompt-file",
      ".siss/skills/summarizer.md",
      "--json-schema",
      JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }),
      "--output-format",
      "json",
      "--max-turns",
      "10",
      "--model",
      "opus",
      "--tools",
      "Read",
      "Process this study according to your instructions.",
    ]);

    expect(capture.options).toMatchObject({
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 12_345,
    });

    const capturedEnv = capture.options?.env;
    expect(capturedEnv).toBeDefined();
    expect(typeof capturedEnv?.HOME).toBe("string");
    expect(typeof capturedEnv?.XDG_CONFIG_HOME).toBe("string");

    expect(capture.writtenStdin).toBe("study input");
    expect(capture.stdinEnded).toBe(true);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(JSON.stringify({ ok: true }));
    expect(result.stderr).toBe("");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("uses explicit model override when provided", async () => {
    const capture: SpawnCapture = { stdinEnded: false };

    await invokeClaudeCode({
      systemPromptFile: "skills/summarizer.md",
      jsonSchema: { type: "object" },
      maxTurns: 2,
      model: "opus",
      timeoutMs: 1000,
      input: "x",
      spawn: makeSpawnStub({
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
        exitCode: 0,
        capture,
      }),
    });

    const modelIndex = capture.cmd?.indexOf("--model") ?? -1;
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    if (!capture.cmd || modelIndex < 0) {
      throw new Error("Expected --model in command");
    }
    expect(capture.cmd[modelIndex + 1]).toBe("opus");
  });

  test("adds --bare only when explicitly enabled", async () => {
    const capture: SpawnCapture = { stdinEnded: false };

    await invokeClaudeCode({
      systemPromptFile: "skills/summarizer.md",
      jsonSchema: { type: "object" },
      maxTurns: 2,
      timeoutMs: 1000,
      input: "x",
      bare: true,
      spawn: makeSpawnStub({
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
        exitCode: 0,
        capture,
      }),
    });

    expect(capture.cmd).toContain("--bare");
  });

  test("allows env override for Claude auth context", async () => {
    const capture: SpawnCapture = { stdinEnded: false };

    await invokeClaudeCode({
      systemPromptFile: "skills/summarizer.md",
      jsonSchema: { type: "object" },
      maxTurns: 2,
      timeoutMs: 1000,
      input: "x",
      env: {
        HOME: "/Users/lasse",
        XDG_CONFIG_HOME: "/Users/lasse/.config",
      },
      spawn: makeSpawnStub({
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
        exitCode: 0,
        capture,
      }),
    });

    expect(capture.options?.env?.HOME).toBe("/Users/lasse");
    expect(capture.options?.env?.XDG_CONFIG_HOME).toBe("/Users/lasse/.config");
  });

  test("throws and persists debug artifact on non-zero exit", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "rhizome-executor-debug-"));

    try {
      const capture: SpawnCapture = { stdinEnded: false };

      await expect(
        invokeClaudeCode({
          systemPromptFile: "skills/summarizer.md",
          jsonSchema: { type: "object" },
          maxTurns: 2,
          timeoutMs: 1000,
          input: "x",
          debugDir,
          spawn: makeSpawnStub({
            stdout: "",
            stderr: "fatal",
            exitCode: 2,
            capture,
          }),
        }),
      ).rejects.toBeInstanceOf(ClaudeCodeInvocationError);

      const files = Array.from(new Bun.Glob("claude-executor-*.txt").scanSync({ cwd: debugDir }));
      expect(files.length).toBe(1);

      const artifactFile = files[0];
      if (!artifactFile) {
        throw new Error("Expected one debug artifact file");
      }

      const artifact = await Bun.file(join(debugDir, artifactFile)).text();
      expect(artifact).toContain("reason: non_zero_exit");
      expect(artifact).toContain("stderr:\nfatal");
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  test("throws and persists debug artifact on non-JSON stdout", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "rhizome-executor-debug-"));

    try {
      const capture: SpawnCapture = { stdinEnded: false };

      await expect(
        invokeClaudeCode({
          systemPromptFile: "skills/summarizer.md",
          jsonSchema: { type: "object" },
          maxTurns: 2,
          timeoutMs: 1000,
          input: "x",
          debugDir,
          spawn: makeSpawnStub({
            stdout: "not json",
            stderr: "",
            exitCode: 0,
            capture,
          }),
        }),
      ).rejects.toBeInstanceOf(ClaudeCodeInvocationError);

      const files = Array.from(new Bun.Glob("claude-executor-*.txt").scanSync({ cwd: debugDir }));
      expect(files.length).toBe(1);

      const artifactFile = files[0];
      if (!artifactFile) {
        throw new Error("Expected one debug artifact file");
      }

      const artifact = await Bun.file(join(debugDir, artifactFile)).text();
      expect(artifact).toContain("reason: non_json_stdout");
      expect(artifact).toContain("stdout:\nnot json");
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  test("throws on Claude JSON error envelope", async () => {
    const capture: SpawnCapture = { stdinEnded: false };

    await expect(
      invokeClaudeCode({
        systemPromptFile: "skills/summarizer.md",
        jsonSchema: { type: "object" },
        maxTurns: 2,
        timeoutMs: 1000,
        input: "x",
        spawn: makeSpawnStub({
          stdout: JSON.stringify({
            type: "result",
            is_error: true,
            result: "Not logged in",
          }),
          stderr: "",
          exitCode: 0,
          capture,
        }),
      }),
    ).rejects.toBeInstanceOf(ClaudeCodeInvocationError);
  });
});
