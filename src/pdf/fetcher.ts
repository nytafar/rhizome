import { rm } from "node:fs/promises";
import { validatePdfFile, type PdfValidationResult } from "./validate";

export type PdfSourceName = "zotero" | "unpaywall" | "europepmc";

export interface PdfFetchStudy {
  sissId: string;
  citekey: string;
  doi?: string | null;
  pmcid?: string | null;
  zoteroKey?: string | null;
}

export interface PdfFetchAttempt {
  source: PdfSourceName;
  outcome: "success" | "no_pdf" | "error" | "invalid_pdf";
  detail?: string;
}

export interface PdfSourceResult {
  filePath?: string;
  noPdf?: boolean;
  detail?: string;
}

export interface PdfSourceAdapter {
  name: PdfSourceName;
  fetchPdf(study: PdfFetchStudy): Promise<PdfSourceResult>;
}

export interface PdfFetcherInput {
  study: PdfFetchStudy;
  sources: PdfSourceAdapter[];
  maxFileSizeMb: number;
}

export interface PdfFetcherResult {
  pdfAvailable: boolean;
  pdfSource?: PdfSourceName;
  pdfPath?: string;
  attempts: PdfFetchAttempt[];
}

async function removeInvalidArtifact(path: string): Promise<void> {
  await rm(path, { force: true });
}

function toInvalidAttempt(
  source: PdfSourceName,
  validation: PdfValidationResult,
): PdfFetchAttempt {
  return {
    source,
    outcome: "invalid_pdf",
    detail: validation.reason,
  };
}

export async function fetchPdfWithWaterfall(input: PdfFetcherInput): Promise<PdfFetcherResult> {
  const attempts: PdfFetchAttempt[] = [];

  for (const source of input.sources) {
    try {
      const result = await source.fetchPdf(input.study);

      if (!result.filePath) {
        attempts.push({
          source: source.name,
          outcome: "no_pdf",
          detail: result.detail ?? (result.noPdf ? "no_pdf" : "no_file_path"),
        });
        continue;
      }

      const validation = await validatePdfFile(result.filePath, {
        maxFileSizeMb: input.maxFileSizeMb,
      });

      if (!validation.valid) {
        await removeInvalidArtifact(result.filePath);
        attempts.push(toInvalidAttempt(source.name, validation));
        continue;
      }

      attempts.push({ source: source.name, outcome: "success" });
      return {
        pdfAvailable: true,
        pdfSource: source.name,
        pdfPath: result.filePath,
        attempts,
      };
    } catch (error) {
      attempts.push({
        source: source.name,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    pdfAvailable: false,
    attempts,
  };
}
