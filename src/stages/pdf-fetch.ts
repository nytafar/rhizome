import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  fetchPdfWithWaterfall,
  type PdfFetchAttempt,
  type PdfFetcherResult,
  type PdfSourceAdapter,
  type PdfSourceName,
} from "../pdf/fetcher";
import { PipelineStep } from "../types/pipeline";
import type { Database as BunSQLiteDatabase } from "bun:sqlite";

interface StudyRow {
  rhizome_id: string;
  citekey: string;
  doi: string | null;
  pmid: string | null;
  zotero_key: string | null;
}

export interface PdfFetchStageInput {
  db: BunSQLiteDatabase;
  rhizomeId: string;
  assetsRootDir: string;
  sourceOrder: PdfSourceName[];
  maxFileSizeMb: number;
  sourceAdapters?: Partial<Record<PdfSourceName, PdfSourceAdapter>>;
}

export interface PdfFetchStageResult {
  pdfAvailable: boolean;
  pdfSource?: PdfSourceName;
  pdfPath?: string;
  attempts: PdfFetchAttempt[];
  metadata: {
    stage: PipelineStep.PDF_FETCH;
    pdfAvailable: boolean;
    pdfSource?: PdfSourceName;
    pdfPath?: string;
    attempts: PdfFetchAttempt[];
  };
}

function loadStudyRow(db: BunSQLiteDatabase, rhizomeId: string): StudyRow {
  const row = db
    .query(
      `
      SELECT rhizome_id, citekey, doi, pmid, zotero_key
      FROM studies
      WHERE rhizome_id = ?
      LIMIT 1;
      `,
    )
    .get(rhizomeId) as StudyRow | null;

  if (!row) {
    throw new Error(`Study not found for rhizome_id=${rhizomeId}`);
  }

  return row;
}

function defaultAdapter(name: PdfSourceName): PdfSourceAdapter {
  return {
    name,
    async fetchPdf() {
      return { noPdf: true, detail: "not_found" };
    },
  };
}

function resolveAdapters(input: PdfFetchStageInput): PdfSourceAdapter[] {
  return input.sourceOrder.map((name) => input.sourceAdapters?.[name] ?? defaultAdapter(name));
}

async function ensureAssetDir(assetsRootDir: string, citekey: string): Promise<void> {
  await mkdir(join(assetsRootDir, citekey), { recursive: true });
}

export async function runPdfFetchStage(input: PdfFetchStageInput): Promise<PdfFetchStageResult> {
  const study = loadStudyRow(input.db, input.rhizomeId);
  await ensureAssetDir(input.assetsRootDir, study.citekey);

  const fetchResult: PdfFetcherResult = await fetchPdfWithWaterfall({
    study: {
      sissId: study.rhizome_id,
      citekey: study.citekey,
      doi: study.doi,
      pmcid: study.pmid,
      zoteroKey: study.zotero_key,
    },
    sources: resolveAdapters(input),
    maxFileSizeMb: input.maxFileSizeMb,
  });

  return {
    ...fetchResult,
    metadata: {
      stage: PipelineStep.PDF_FETCH,
      pdfAvailable: fetchResult.pdfAvailable,
      pdfSource: fetchResult.pdfSource,
      pdfPath: fetchResult.pdfPath,
      attempts: fetchResult.attempts,
    },
  };
}

export const stageHandlerRegistry = {
  [PipelineStep.PDF_FETCH]: runPdfFetchStage,
};
