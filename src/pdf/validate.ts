export interface PdfValidationOptions {
  maxFileSizeMb?: number;
}

export interface PdfValidationResult {
  valid: boolean;
  reason?: "missing" | "empty" | "too_large" | "invalid_header";
  sizeBytes: number;
}

const PDF_MAGIC = "%PDF-";

export async function validatePdfFile(
  path: string,
  options: PdfValidationOptions = {},
): Promise<PdfValidationResult> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return { valid: false, reason: "missing", sizeBytes: 0 };
  }

  const sizeBytes = file.size;
  if (sizeBytes <= 0) {
    return { valid: false, reason: "empty", sizeBytes };
  }

  if (options.maxFileSizeMb !== undefined) {
    const maxFileSizeBytes = options.maxFileSizeMb * 1024 * 1024;
    if (sizeBytes > maxFileSizeBytes) {
      return { valid: false, reason: "too_large", sizeBytes };
    }
  }

  const headerBytes = new Uint8Array(await file.slice(0, PDF_MAGIC.length).arrayBuffer());
  const header = new TextDecoder().decode(headerBytes);

  if (header !== PDF_MAGIC) {
    return { valid: false, reason: "invalid_header", sizeBytes };
  }

  return { valid: true, sizeBytes };
}
