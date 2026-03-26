import type { RhizomeConfig } from "../config/schema";
import type { FulltextPipelineStep } from "../types/pipeline";

export type ParserProviderId = RhizomeConfig["parser"]["active_provider"] | "docling" | "grobid";

export interface ParseOptions {
  pageRange?: string;
  forceOcr?: boolean;
  timeoutMs?: number;
}

export interface ParseResultMetadata {
  stage: FulltextPipelineStep;
  pageCount: number;
  provider: ParserProviderId;
  providerVersion: string;
  parsedAt: string;
  hasImages: boolean;
  hasTables: boolean;
}

export interface ParseResult {
  markdownPath: string;
  metadata: ParseResultMetadata;
}

export interface MarkdownProvider {
  id: ParserProviderId;
  name: string;
  parse(pdfPath: string, outputDir: string, options?: ParseOptions): Promise<ParseResult>;
  healthcheck(): Promise<boolean>;
}
