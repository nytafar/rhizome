import { describe, expect, test } from "bun:test";
import type { ZoteroItem } from "../client";
import {
  extractPmcid,
  extractPmid,
  mapZoteroItemToStudyRecord,
  parseYearFromZoteroDate,
} from "../field-mapper";

function makeCollectionMap(): Map<string, string> {
  return new Map([
    ["COLL1", "Test"],
    ["COLL2", "Clinical Trials"],
  ]);
}

describe("mapZoteroItemToStudyRecord", () => {
  test("maps journal article fields with DOI, PMID, PMCID and collection names", () => {
    const item: ZoteroItem = {
      key: "JOURNAL123",
      version: 41,
      data: {
        itemType: "journalArticle",
        title: "Effects of adaptogens on stress biomarkers",
        creators: [
          { creatorType: "author", firstName: "Jane", lastName: "Doe" },
          { creatorType: "author", firstName: "Rahul", lastName: "Patel" },
          { creatorType: "editor", firstName: "Skip", lastName: "Me" },
        ],
        date: "2023-05-01",
        publicationTitle: "Phytomedicine",
        DOI: "https://doi.org/10.1000/xyz123",
        url: "https://example.org/paper",
        abstractNote: "Double-blind randomized trial",
        volume: "52",
        issue: "3",
        pages: "12-20",
        extra: "PMID: 37291847\nPMCID: PMC9876543",
        tags: [{ tag: "adaptogens" }, { tag: "stress" }],
        collections: ["COLL1", "COLL2"],
        dateAdded: "2026-03-25T17:00:00Z",
      },
    };

    const mapped = mapZoteroItemToStudyRecord(item, {
      collectionNamesByKey: makeCollectionMap(),
    });

    expect(mapped).not.toBeNull();
    expect(mapped).toMatchObject({
      zotero_key: "JOURNAL123",
      zotero_version: 41,
      title: "Effects of adaptogens on stress biomarkers",
      authors: [
        { given: "Jane", family: "Doe" },
        { given: "Rahul", family: "Patel" },
      ],
      year: 2023,
      journal: "Phytomedicine",
      doi: "10.1000/xyz123",
      url: "https://example.org/paper",
      abstract: "Double-blind randomized trial",
      volume: "52",
      issue: "3",
      pages: "12-20",
      item_type: "journalArticle",
      pmid: "37291847",
      pmcid: "PMC9876543",
      source_tags: ["adaptogens", "stress"],
      source_collections: ["Test", "Clinical Trials"],
      date_added: "2026-03-25T17:00:00Z",
      source: "zotero",
    });
  });

  test("maps a book and parses year from free-form date", () => {
    const item: ZoteroItem = {
      key: "BOOK123",
      version: 15,
      data: {
        itemType: "book",
        title: "Herbal Medicine Handbook",
        creators: [{ creatorType: "author", firstName: "Mila", lastName: "Hart" }],
        date: "Spring 2018",
        extra: "ISBN: 9780000000000",
        collections: ["UNKNOWN_COLL"],
      },
    };

    const mapped = mapZoteroItemToStudyRecord(item, {
      collectionNamesByKey: makeCollectionMap(),
    });

    expect(mapped).not.toBeNull();
    expect(mapped).toMatchObject({
      item_type: "book",
      year: 2018,
      source_collections: ["UNKNOWN_COLL"],
      source: "zotero",
    });
  });

  test("maps preprint and normalizes DOI prefix", () => {
    const item: ZoteroItem = {
      key: "PREPRINT123",
      version: 7,
      data: {
        itemType: "preprint",
        title: "Novel pathways in inflammation",
        creators: [{ creatorType: "author", firstName: "A", lastName: "Researcher" }],
        date: "2024",
        DOI: "doi: 10.5555/preprint.2024.1",
      },
    };

    const mapped = mapZoteroItemToStudyRecord(item);

    expect(mapped).not.toBeNull();
    expect(mapped).toMatchObject({
      item_type: "preprint",
      doi: "10.5555/preprint.2024.1",
      year: 2024,
      source: "zotero",
    });
  });

  test("maps no-DOI item and still extracts PMID from extra", () => {
    const item: ZoteroItem = {
      key: "NODOI123",
      version: 28,
      data: {
        itemType: "conferencePaper",
        title: "Conference findings",
        creators: [{ creatorType: "author", firstName: "Nora", lastName: "Li" }],
        date: "2022/09/14",
        extra: "Trial registry X\nPMID: 12345678",
      },
    };

    const mapped = mapZoteroItemToStudyRecord(item);

    expect(mapped).not.toBeNull();
    expect(mapped).toMatchObject({
      item_type: "conferencePaper",
      doi: undefined,
      pmid: "12345678",
      pmcid: undefined,
      year: 2022,
      source: "zotero",
    });
  });

  test("returns null for unsupported/filtered item types", () => {
    const noteItem: ZoteroItem = {
      key: "NOTE123",
      version: 1,
      data: {
        itemType: "note",
        title: "Skip me",
      },
    };

    expect(mapZoteroItemToStudyRecord(noteItem)).toBeNull();
  });
});

describe("extraction and parsing helpers", () => {
  test("extracts PMID and PMCID from case-insensitive multiline extra field", () => {
    const extra = "something\npmid: 99887766\npmcid: pmc112233";

    expect(extractPmid(extra)).toBe("99887766");
    expect(extractPmcid(extra)).toBe("PMC112233");
  });

  test("parses year from varied Zotero date strings", () => {
    expect(parseYearFromZoteroDate("2021-11-07")).toBe(2021);
    expect(parseYearFromZoteroDate("March 2019")).toBe(2019);
    expect(parseYearFromZoteroDate("not-a-date")).toBeUndefined();
  });
});
