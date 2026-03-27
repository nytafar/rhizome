import { join } from "node:path";
import type { Database as BunSQLiteDatabase } from "bun:sqlite";
import type { ParseResult, ParseResultMetadata } from "../parser/types";
import type { ParserRegistry } from "../parser/registry";
import { PipelineStep } from "../types/pipeline";

interface StudyRow {
  siss_id: string;
  citekey: string;
}

interface JobMetadataRow {
  id: number;
  metadata: string;
}

interface PdfFetchMetadata {
  pdfAvailable: boolean;
  pdfPath?: string;
  pdfSource?: unknown;
  attempts?: unknown;
}

export interface FulltextMarkerStageInput {
  db: BunSQLiteDatabase;
  sissId: string;
  assetsRootDir: string;
  parserRegistry: Pick<ParserRegistry, "getActive">;
}

export interface FulltextMarkerStageResult {
  skipped: boolean;
  reason?: "no_pdf";
  fulltextPath?: string;
  metadata: {
    stage: PipelineStep.FULLTEXT_MARKER;
    skipped: boolean;
    reason?: "no_pdf";
    pdfPath?: string;
    fulltextPath?: string;
    provider?: string;
    providerVersion?: string;
    parsedAt?: string;
    pageCount?: number;
    hasImages?: boolean;
    hasTables?: boolean;
  };
}

function loadStudyRow(db: BunSQLiteDatabase, sissId: string): StudyRow {
  const row = db
    .query(
      `
      SELECT siss_id, citekey
      FROM studies
      WHERE siss_id = ?
      LIMIT 1;
      `,
    )
    .get(sissId) as StudyRow | null;

  if (!row) {
    throw new Error(`Study not found for siss_id=${sissId}`);
  }

  return row;
}

function loadLatestCompletedPdfFetchMetadata(
  db: BunSQLiteDatabase,
  sissId: string,
): PdfFetchMetadata | null {
  const row = db
    .query(
      `
      SELECT id, metadata
      FROM jobs
      WHERE siss_id = ?
        AND stage = ?
        AND status = 'complete'
        AND metadata IS NOT NULL
      ORDER BY completed_at DESC, id DESC
      LIMIT 1;
      `,
    )
    .get(sissId, PipelineStep.PDF_FETCH) as JobMetadataRow | null;

  if (!row?.metadata) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.metadata) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const metadata = parsed as {
      pdfAvailable?: unknown;
      pdfPath?: unknown;
      pdfSource?: unknown;
      attempts?: unknown;
    };

    return {
      pdfAvailable: metadata.pdfAvailable === true,
      pdfPath: typeof metadata.pdfPath === "string" && metadata.pdfPath.trim().length > 0
        ? metadata.pdfPath
        : undefined,
      pdfSource: metadata.pdfSource,
      attempts: metadata.attempts,
    };
  } catch {
    return null;
  }
}

function buildNoPdfResult(): FulltextMarkerStageResult {
  return {
    skipped: true,
    reason: "no_pdf",
    metadata: {
      stage: PipelineStep.FULLTEXT_MARKER,
      skipped: true,
      reason: "no_pdf",
    },
  };
}

function validateParseResult(result: ParseResult): ParseResult {
  if (typeof result.markdownPath !== "string" || result.markdownPath.trim().length === 0) {
    throw new Error("fulltext.marker parse result is invalid: markdownPath is required.");
  }

  if (!result.metadata || typeof result.metadata !== "object") {
    throw new Error("fulltext.marker parse result is invalid: metadata is required.");
  }

  const metadata = result.metadata as ParseResultMetadata;

  if (typeof metadata.provider !== "string" || metadata.provider.trim().length === 0) {
    throw new Error("fulltext.marker parse result is invalid: metadata.provider is required.");
  }

  if (typeof metadata.providerVersion !== "string" || metadata.providerVersion.trim().length === 0) {
    throw new Error(
      "fulltext.marker parse result is invalid: metadata.providerVersion is required.",
    );
  }

  if (typeof metadata.parsedAt !== "string" || metadata.parsedAt.trim().length === 0) {
    throw new Error("fulltext.marker parse result is invalid: metadata.parsedAt is required.");
  }

  if (!Number.isFinite(metadata.pageCount)) {
    throw new Error("fulltext.marker parse result is invalid: metadata.pageCount is required.");
  }

  if (typeof metadata.hasImages !== "boolean" || typeof metadata.hasTables !== "boolean") {
    throw new Error(
      "fulltext.marker parse result is invalid: metadata.hasImages and metadata.hasTables are required.",
    );
  }

  return result;
}

export async function runFulltextMarkerStage(
  input: FulltextMarkerStageInput,
): Promise<FulltextMarkerStageResult> {
  const study = loadStudyRow(input.db, input.sissId);
  const pdfFetchMetadata = loadLatestCompletedPdfFetchMetadata(input.db, input.sissId);

  if (!pdfFetchMetadata?.pdfAvailable || !pdfFetchMetadata.pdfPath) {
    return buildNoPdfResult();
  }

  const provider = input.parserRegistry.getActive();
  const outputDir = join(input.assetsRootDir, study.citekey);
  const parseResult = validateParseResult(await provider.parse(pdfFetchMetadata.pdfPath, outputDir));

  return {
    skipped: false,
    fulltextPath: parseResult.markdownPath,
    metadata: {
      stage: PipelineStep.FULLTEXT_MARKER,
      skipped: false,
      pdfPath: pdfFetchMetadata.pdfPath,
      fulltextPath: parseResult.markdownPath,
      provider: parseResult.metadata.provider,
      providerVersion: parseResult.metadata.providerVersion,
      parsedAt: parseResult.metadata.parsedAt,
      pageCount: parseResult.metadata.pageCount,
      hasImages: parseResult.metadata.hasImages,
      hasTables: parseResult.metadata.hasTables,
    },
  };
}

export type FulltextMarkerStageHandler = (
  input: FulltextMarkerStageInput,
) => Promise<FulltextMarkerStageResult>;

export const stageHandlerRegistry: Partial<Record<PipelineStep, FulltextMarkerStageHandler>> = {
  [PipelineStep.FULLTEXT_MARKER]: runFulltextMarkerStage,
};
