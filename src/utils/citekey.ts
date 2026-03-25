import type { Author } from "../types/study";

const MAX_CITEKEY_LENGTH = 60;

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "for",
  "and",
  "with",
  "is",
  "are",
  "was",
  "were",
  "from",
  "by",
  "to",
  "at",
  "as",
]);

export interface CitekeyInput {
  authors: Author[];
  year: number;
  title: string;
}

function normalizeAscii(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstMeaningfulWord(title: string): string {
  const normalized = normalizeAscii(title);
  const words = normalized.split(" ").filter(Boolean);

  for (const word of words) {
    if (!STOPWORDS.has(word)) {
      return word;
    }
  }

  return words[0] ?? "study";
}

function normalizeFamilyName(authors: Author[]): string {
  const family = authors[0]?.family ?? "unknown";
  const normalized = normalizeAscii(family).replace(/\s+/g, "");
  return normalized || "unknown";
}

function toYearString(year: number): string {
  const intYear = Math.trunc(year);
  if (intYear >= 1000 && intYear <= 9999) {
    return String(intYear);
  }

  return String(intYear).slice(0, 4).padStart(4, "0");
}

function withMaxLength(base: string): string {
  return base.slice(0, MAX_CITEKEY_LENGTH);
}

function suffixFromIndex(index: number): string {
  if (index <= 0) {
    return "";
  }

  // 1 => b, 2 => c, ..., 25 => z, 26 => aa, 27 => ab ...
  let value = index;
  let suffix = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    suffix = String.fromCharCode(97 + remainder) + suffix;
    value = Math.floor((value - 1) / 26);
  }

  if (suffix[0] === "a") {
    return `a${suffix}`.slice(1);
  }

  return suffix;
}

function collisionSuffix(attempt: number): string {
  if (attempt === 0) {
    return "";
  }

  // first collision should be "b"
  return suffixFromIndex(attempt + 1);
}

export function generateBaseCitekey(input: CitekeyInput): string {
  const firstAuthor = normalizeFamilyName(input.authors);
  const year = toYearString(input.year);
  const titleWord = extractFirstMeaningfulWord(input.title);

  return withMaxLength(`${firstAuthor}${year}${titleWord}`);
}

export function generateCitekey(
  input: CitekeyInput,
  existingCitekeys: Iterable<string> = [],
): string {
  const existing = new Set(existingCitekeys);
  const base = generateBaseCitekey(input);

  if (!existing.has(base)) {
    return base;
  }

  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const suffix = collisionSuffix(attempt);
    const maxBaseLength = MAX_CITEKEY_LENGTH - suffix.length;
    const candidate = `${base.slice(0, maxBaseLength)}${suffix}`;

    if (!existing.has(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to generate unique citekey after 999 attempts");
}
