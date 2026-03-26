import matter from "gray-matter";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { PipelineStep } from "../types/pipeline";
import type { ParseOptions, ParseResult, ParseResultMetadata } from "./types";

export interface MarkerProviderSubprocessRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface MarkerProviderSubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type MarkerProviderSubprocessRunner = (
  request: MarkerProviderSubprocessRequest,
) => Promise<MarkerProviderSubprocessResult>;

export interface MarkerProviderOptions {
  markerBinary: string;
  markerVersion: string;
  defaultTimeoutMs: number;
  defaultForceOcr?: boolean;
  runSubprocess?: MarkerProviderSubprocessRunner;
  now?: () => Date;
}

export interface MarkerProviderErrorContext {
  code:
    | "subprocess_non_zero_exit"
    | "subprocess_timeout"
    | "missing_output_markdown"
    | "invalid_output_layout"
    | "malformed_markdown_image_ref"
    | "figure_relocation_failure";
  command?: string;
  args?: string[];
  exitCode?: number;
  timeoutMs?: number;
  stderr?: string;
  stdout?: string;
  expectedPath?: string;
  rootPath?: string;
  sourcePath?: string;
  targetPath?: string;
  imageRef?: string;
  reason?: string;
}

export class MarkerProviderError extends Error {
  public readonly context: MarkerProviderErrorContext;

  public constructor(message: string, context: MarkerProviderErrorContext) {
    super(message);
    this.name = "MarkerProviderError";
    this.context = context;
  }
}

class MarkerSubprocessTimeoutError extends Error {
  public readonly command: string;
  public readonly args: string[];
  public readonly timeoutMs: number;

  public constructor(command: string, args: string[], timeoutMs: number) {
    super(`Marker command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`.trim());
    this.name = "MarkerSubprocessTimeoutError";
    this.command = command;
    this.args = args;
    this.timeoutMs = timeoutMs;
  }
}

function summarizeOutput(stdout: string, stderr: string): { stdout: string; stderr: string } {
  const normalize = (value: string): string => {
    const firstLine = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    if (!firstLine) {
      return "";
    }

    if (firstLine.length <= 240) {
      return firstLine;
    }

    return `${firstLine.slice(0, 237)}...`;
  };

  return {
    stdout: normalize(stdout),
    stderr: normalize(stderr),
  };
}

async function defaultRunSubprocess(
  request: MarkerProviderSubprocessRequest,
): Promise<MarkerProviderSubprocessResult> {
  const processRef = Bun.spawn([request.command, ...request.args], {
    cwd: request.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      processRef.kill();
      reject(
        new MarkerSubprocessTimeoutError(
          request.command,
          request.args,
          request.timeoutMs,
        ),
      );
    }, request.timeoutMs);

    processRef.exited.finally(() => {
      clearTimeout(timer);
    });
  });

  const exitCode = (await Promise.race([processRef.exited, timeoutPromise])) as number;

  return {
    exitCode,
    stdout: await new Response(processRef.stdout).text(),
    stderr: await new Response(processRef.stderr).text(),
  };
}

function ensurePathWithinRoot(rootPath: string, targetPath: string, reason: string): void {
  const absoluteRoot = resolve(rootPath);
  const absoluteTarget = resolve(targetPath);
  const rel = relative(absoluteRoot, absoluteTarget);

  if (rel.startsWith("..") || rel.length === 0 && absoluteTarget !== absoluteRoot) {
    throw new MarkerProviderError(
      `Marker output layout is invalid: ${reason}. target=${absoluteTarget}, root=${absoluteRoot}`,
      {
        code: "invalid_output_layout",
        reason,
        rootPath: absoluteRoot,
        targetPath: absoluteTarget,
      },
    );
  }
}

function sanitizeFileName(fileName: string): string {
  const normalized = fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
  return normalized.length > 0 ? normalized : "figure";
}

function countPageEstimate(markdown: string): number {
  const pageMarkers = markdown.match(/\{#page_\d+\}/g)?.length ?? 0;
  if (pageMarkers > 0) {
    return pageMarkers;
  }

  return markdown.trim().length > 0 ? 1 : 0;
}

function detectHasTables(markdown: string): boolean {
  return /\|\s*[-:]{3,}\s*\|/.test(markdown);
}

function stripOptionalTitleFromImageRef(rawRef: string): string {
  const trimmed = rawRef.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const quoteIndex = trimmed.search(/\s+["']/);
  if (quoteIndex === -1) {
    return trimmed;
  }

  return trimmed.slice(0, quoteIndex).trim();
}

async function rewriteImageLinks(params: {
  markdown: string;
  outputTreeRoot: string;
  markdownDir: string;
  figuresDir: string;
}): Promise<{
  rewrittenMarkdown: string;
  copyOperations: Array<{ source: string; target: string }>;
  hasImages: boolean;
}> {
  const imagePattern = /!\[[^\]]*\]\(([^)]*)\)/g;
  const usedNames = new Set<string>();
  const sourceToTarget = new Map<string, string>();
  const copyOperations: Array<{ source: string; target: string }> = [];
  let hasImages = false;
  let rewrittenMarkdown = "";
  let lastIndex = 0;

  for (const match of params.markdown.matchAll(imagePattern)) {
    const fullMatch = match[0];
    const rawRef = match[1] ?? "";
    const matchIndex = match.index ?? 0;

    rewrittenMarkdown += params.markdown.slice(lastIndex, matchIndex);

    const extractedRef = stripOptionalTitleFromImageRef(rawRef);

    if (extractedRef.length === 0) {
      throw new MarkerProviderError(
        `Malformed marker markdown image reference: '${String(rawRef)}'.`,
        {
          code: "malformed_markdown_image_ref",
          imageRef: String(rawRef),
        },
      );
    }

    if (
      extractedRef.startsWith("http://") ||
      extractedRef.startsWith("https://") ||
      extractedRef.startsWith("data:") ||
      extractedRef.startsWith("#")
    ) {
      rewrittenMarkdown += fullMatch;
      lastIndex = matchIndex + fullMatch.length;
      continue;
    }

    const absoluteSource = resolve(params.markdownDir, extractedRef);
    ensurePathWithinRoot(params.outputTreeRoot, absoluteSource, "image ref escapes marker output tree");

    const sourceExists = await Bun.file(absoluteSource).exists();
    if (!sourceExists) {
      // Explicit rule: keep unresolved local refs untouched when source asset does not exist.
      rewrittenMarkdown += fullMatch;
      lastIndex = matchIndex + fullMatch.length;
      continue;
    }

    if (!sourceToTarget.has(absoluteSource)) {
      const sourceBase = sanitizeFileName(basename(absoluteSource));
      const extension = extname(sourceBase);
      const stem = extension.length > 0 ? sourceBase.slice(0, -extension.length) : sourceBase;

      let nextName = sourceBase;
      let counter = 2;
      while (usedNames.has(nextName)) {
        nextName = `${stem}-${counter}${extension}`;
        counter += 1;
      }

      usedNames.add(nextName);
      const absoluteTarget = join(params.figuresDir, nextName);
      sourceToTarget.set(absoluteSource, absoluteTarget);
      copyOperations.push({ source: absoluteSource, target: absoluteTarget });
    }

    const targetPath = sourceToTarget.get(absoluteSource);
    if (!targetPath) {
      throw new MarkerProviderError("Figure relocation plan failed unexpectedly.", {
        code: "figure_relocation_failure",
        sourcePath: absoluteSource,
        reason: "missing target mapping",
      });
    }

    hasImages = true;
    const relativeTarget = relative(dirname(params.figuresDir), targetPath).replaceAll("\\", "/");

    rewrittenMarkdown += fullMatch.replace(rawRef, relativeTarget);
    lastIndex = matchIndex + fullMatch.length;
  }

  rewrittenMarkdown += params.markdown.slice(lastIndex);

  return {
    rewrittenMarkdown,
    copyOperations,
    hasImages,
  };
}

function buildFulltextMarkdown(params: {
  citekey: string;
  metadata: ParseResultMetadata;
  markdownBody: string;
}): string {
  return matter.stringify(params.markdownBody, {
    note_type: "study_fulltext",
    study_ref: params.citekey,
    parser_provider: params.metadata.provider,
    parser_version: params.metadata.providerVersion,
    parsed_at: params.metadata.parsedAt,
    page_count: params.metadata.pageCount,
    has_tables: params.metadata.hasTables,
    has_images: params.metadata.hasImages,
  });
}

export class MarkerProvider {
  public readonly id = "marker" as const;
  public readonly name = "Marker PDF";

  private readonly markerBinary: string;
  private readonly markerVersion: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultForceOcr: boolean;
  private readonly runSubprocess: MarkerProviderSubprocessRunner;
  private readonly now: () => Date;

  public constructor(options: MarkerProviderOptions) {
    this.markerBinary = options.markerBinary;
    this.markerVersion = options.markerVersion;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.defaultForceOcr = options.defaultForceOcr ?? false;
    this.runSubprocess = options.runSubprocess ?? defaultRunSubprocess;
    this.now = options.now ?? (() => new Date());
  }

  public async healthcheck(): Promise<boolean> {
    try {
      const result = await this.runSubprocess({
        command: this.markerBinary,
        args: ["--help"],
        cwd: process.cwd(),
        timeoutMs: this.defaultTimeoutMs,
      });

      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  public async parse(
    pdfPath: string,
    outputDir: string,
    options?: ParseOptions,
  ): Promise<ParseResult> {
    if (!isAbsolute(pdfPath) || !isAbsolute(outputDir)) {
      throw new MarkerProviderError(
        "MarkerProvider.parse requires absolute pdfPath and outputDir.",
        {
          code: "invalid_output_layout",
          reason: "non-absolute-path-input",
          sourcePath: pdfPath,
          rootPath: outputDir,
        },
      );
    }

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const forceOcr = options?.forceOcr ?? this.defaultForceOcr;
    const pdfStem = basename(pdfPath, extname(pdfPath));
    const markerOutputRoot = join(outputDir, ".marker-output");

    await mkdir(markerOutputRoot, { recursive: true });

    const args = [
      pdfPath,
      "--output_dir",
      markerOutputRoot,
      "--output_format",
      "markdown",
    ];

    if (forceOcr) {
      args.push("--force_ocr");
    }

    if (options?.pageRange) {
      args.push("--page_range", options.pageRange);
    }

    let subprocessResult: MarkerProviderSubprocessResult;

    try {
      subprocessResult = await this.runSubprocess({
        command: this.markerBinary,
        args,
        cwd: outputDir,
        timeoutMs,
      });
    } catch (error) {
      if (
        error instanceof MarkerSubprocessTimeoutError ||
        (
          error instanceof Error
          && error.name === "MarkerSubprocessTimeoutError"
          && "timeoutMs" in error
        )
      ) {
        const timeoutError = error as Error & {
          command?: string;
          args?: string[];
          timeoutMs?: unknown;
        };
        const timeoutMsValue = typeof timeoutError.timeoutMs === "number"
          ? timeoutError.timeoutMs
          : timeoutMs;

        throw new MarkerProviderError(
          `Marker parse timed out after ${timeoutMsValue}ms while running '${timeoutError.command ?? this.markerBinary}'.`,
          {
            code: "subprocess_timeout",
            command: timeoutError.command ?? this.markerBinary,
            args: Array.isArray(timeoutError.args) ? timeoutError.args : args,
            timeoutMs: timeoutMsValue,
          },
        );
      }

      const reason = error instanceof Error ? error.message : String(error);
      throw new MarkerProviderError(`Marker subprocess invocation failed: ${reason}`, {
        code: "subprocess_non_zero_exit",
        command: this.markerBinary,
        args,
        reason,
      });
    }

    if (subprocessResult.exitCode !== 0) {
      const summary = summarizeOutput(subprocessResult.stdout, subprocessResult.stderr);

      throw new MarkerProviderError(
        `Marker parse failed with exit code ${subprocessResult.exitCode}. ${summary.stderr || summary.stdout}`.trim(),
        {
          code: "subprocess_non_zero_exit",
          command: this.markerBinary,
          args,
          exitCode: subprocessResult.exitCode,
          stderr: summary.stderr,
          stdout: summary.stdout,
        },
      );
    }

    const markerMarkdownPath = join(markerOutputRoot, pdfStem, `${pdfStem}.md`);

    if (!(await Bun.file(markerMarkdownPath).exists())) {
      throw new MarkerProviderError(
        `Marker output markdown is missing at expected path: ${markerMarkdownPath}`,
        {
          code: "missing_output_markdown",
          expectedPath: markerMarkdownPath,
          rootPath: markerOutputRoot,
        },
      );
    }

    ensurePathWithinRoot(markerOutputRoot, markerMarkdownPath, "markdown output path escapes output root");

    const markerMarkdown = await readFile(markerMarkdownPath, "utf8");
    const figuresDir = join(outputDir, "figures");

    const rewritePlan = await rewriteImageLinks({
      markdown: markerMarkdown,
      outputTreeRoot: markerOutputRoot,
      markdownDir: dirname(markerMarkdownPath),
      figuresDir,
    });

    await mkdir(figuresDir, { recursive: true });

    for (const operation of rewritePlan.copyOperations) {
      const sourceExists = await Bun.file(operation.source).exists();
      if (!sourceExists) {
        // Explicit rule: non-existent refs are ignored and left unchanged in markdown.
        continue;
      }

      try {
        await copyFile(operation.source, operation.target);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new MarkerProviderError(
          `Failed to relocate figure '${operation.source}' to '${operation.target}': ${reason}`,
          {
            code: "figure_relocation_failure",
            sourcePath: operation.source,
            targetPath: operation.target,
            reason,
          },
        );
      }
    }

    const metadata: ParseResultMetadata = {
      stage: PipelineStep.FULLTEXT_MARKER,
      pageCount: countPageEstimate(rewritePlan.rewrittenMarkdown),
      provider: this.id,
      providerVersion: this.markerVersion,
      parsedAt: this.now().toISOString(),
      hasImages: rewritePlan.hasImages,
      hasTables: detectHasTables(rewritePlan.rewrittenMarkdown),
    };

    const fulltextPath = join(outputDir, "fulltext.md");
    const citekey = basename(outputDir);
    const fulltextMarkdown = buildFulltextMarkdown({
      citekey,
      metadata,
      markdownBody: rewritePlan.rewrittenMarkdown,
    });

    await Bun.write(fulltextPath, fulltextMarkdown);

    return {
      markdownPath: fulltextPath,
      metadata,
    };
  }
}
