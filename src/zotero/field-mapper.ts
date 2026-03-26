import type { Author } from "../types/study";
import type { ZoteroItem } from "./client";

const DEFAULT_ALLOWED_ITEM_TYPES = new Set([
  "journalArticle",
  "book",
  "bookSection",
  "preprint",
  "conferencePaper",
]);

export interface MappedStudyRecord {
  zotero_key: string;
  zotero_version: number;
  title: string;
  authors: Author[];
  year?: number;
  journal?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  item_type?: string;
  pmid?: string;
  pmcid?: string;
  source_tags?: string[];
  source_collections?: string[];
  date_added?: string;
  source: "zotero";
}

export interface FieldMapperOptions {
  collectionNamesByKey?: ReadonlyMap<string, string>;
  allowedItemTypes?: ReadonlySet<string>;
}

export function mapZoteroItemToStudyRecord(
  item: ZoteroItem,
  options: FieldMapperOptions = {},
): MappedStudyRecord | null {
  const itemType = asTrimmedString(item.data?.itemType);
  if (!shouldProcessZoteroItemType(itemType, options.allowedItemTypes)) {
    return null;
  }

  const doi = normalizeDoi(item.data?.DOI);
  const extra = asTrimmedString(item.data?.extra);

  return {
    zotero_key: item.key,
    zotero_version: item.version,
    title: asTrimmedString(item.data?.title) ?? "",
    authors: mapAuthors(item.data?.creators),
    year: parseYearFromZoteroDate(item.data?.date),
    journal: asTrimmedString(item.data?.publicationTitle),
    doi,
    url: asTrimmedString(item.data?.url),
    abstract: asTrimmedString(item.data?.abstractNote),
    volume: asTrimmedString(item.data?.volume),
    issue: asTrimmedString(item.data?.issue),
    pages: asTrimmedString(item.data?.pages),
    item_type: itemType,
    pmid: extractPmid(extra),
    pmcid: extractPmcid(extra),
    source_tags: mapTags(item.data?.tags),
    source_collections: resolveCollectionNames(
      item.data?.collections,
      options.collectionNamesByKey,
    ),
    date_added: asTrimmedString(item.data?.dateAdded),
    source: "zotero",
  };
}

export function shouldProcessZoteroItemType(
  itemType: string | undefined,
  allowedItemTypes: ReadonlySet<string> = DEFAULT_ALLOWED_ITEM_TYPES,
): boolean {
  if (!itemType) {
    return false;
  }

  return allowedItemTypes.has(itemType);
}

export function extractPmid(extra: string | undefined): string | undefined {
  if (!extra) {
    return undefined;
  }

  return extra.match(/\bPMID\s*:\s*(\d+)\b/i)?.[1];
}

export function extractPmcid(extra: string | undefined): string | undefined {
  if (!extra) {
    return undefined;
  }

  return extra.match(/\bPMCID\s*:\s*(PMC\d+)\b/i)?.[1]?.toUpperCase();
}

export function parseYearFromZoteroDate(rawDate: unknown): number | undefined {
  const value = asTrimmedString(rawDate);
  if (!value) {
    return undefined;
  }

  const fourDigitYear = value.match(/\b(19|20)\d{2}\b/);
  if (fourDigitYear?.[0]) {
    return Number(fourDigitYear[0]);
  }

  const parsedMs = Date.parse(value);
  if (!Number.isNaN(parsedMs)) {
    return new Date(parsedMs).getUTCFullYear();
  }

  return undefined;
}

export function resolveCollectionNames(
  collectionKeys: unknown,
  collectionNamesByKey: ReadonlyMap<string, string> | undefined,
): string[] | undefined {
  if (!Array.isArray(collectionKeys)) {
    return undefined;
  }

  const resolved = collectionKeys
    .map((key) => asTrimmedString(key))
    .filter((key): key is string => Boolean(key))
    .map((key) => collectionNamesByKey?.get(key) ?? key);

  return resolved.length > 0 ? resolved : undefined;
}

function normalizeDoi(value: unknown): string | undefined {
  const doi = asTrimmedString(value);
  if (!doi) {
    return undefined;
  }

  return doi
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

function mapAuthors(creators: unknown): Author[] {
  if (!Array.isArray(creators)) {
    return [];
  }

  return creators
    .filter((creator) =>
      Boolean(
        creator &&
          typeof creator === "object" &&
          "creatorType" in creator &&
          creator.creatorType === "author",
      ),
    )
    .map((creator) => {
      if (!creator || typeof creator !== "object") {
        return null;
      }

      const given = asTrimmedString((creator as Record<string, unknown>).firstName);
      const family = asTrimmedString((creator as Record<string, unknown>).lastName);
      if (!given || !family) {
        return null;
      }

      return { given, family } satisfies Author;
    })
    .filter((author): author is Author => author !== null);
}

function mapTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) {
    return undefined;
  }

  const mapped = tags
    .map((tag) => {
      if (!tag || typeof tag !== "object") {
        return undefined;
      }

      return asTrimmedString((tag as Record<string, unknown>).tag);
    })
    .filter((tag): tag is string => Boolean(tag));

  return mapped.length > 0 ? mapped : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
