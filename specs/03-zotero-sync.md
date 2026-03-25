# 03 — Zotero Sync

**Version:** 0.2 | **Status:** Draft for review
**Depends on:** 00-architecture-overview, 01-schema-vault-design, 02-pipeline-queue
**Consumed by:** Pipeline (as `ingest` + `zotero_sync` step implementation)

---

## 1. Purpose

This spec defines how Rhizome communicates with the Zotero Web API: pulling items, detecting changes, mapping fields, and optionally pushing studies back to Zotero.

## 2. Zotero Web API Essentials

### Authentication
- User ID + API key (generated at zotero.org/settings/keys)
- All requests: `Zotero-API-Key: {key}` header
- Rate limits: undocumented but generally ~100 req/min for reads

### Key Endpoints
```
GET /users/{uid}/items?since={version}&format=json
GET /users/{uid}/deleted?since={version}
GET /users/{uid}/items/{key}?format=json
GET /users/{uid}/items/{key}/file         # download attachment
GET /users/{uid}/collections?format=json
POST /users/{uid}/items                   # create items
PATCH /users/{uid}/items/{key}            # update items
```

### Delta Sync Protocol
Zotero uses a library-wide version number. Every modification increments it.
- Request: `GET /items?since={last_known_version}`
- Response includes `Last-Modified-Version` header
- If response version > stored version: there are new/modified items
- Store the response version for next sync

## 3. Sync Flow: Zotero → Vault

```
1. Read last_library_version from zotero_sync_state table
2. GET /users/{uid}/items?since={version}&format=json&limit=100
   (paginate: follow `rel="next"` Link headers)
3. For each item:
   a. Map Zotero item → StudyRecord (Section 5)
   b. Check dedup by `zotero_key` (primary), DOI/PMID (secondary fallback)
      → EXISTS + same zotero_version: skip (no changes)
      → EXISTS + different version: update study, re-enqueue from `zotero_sync`
      → NEW: insert study, enqueue from `ingest`
4. Fetch deleted keys: GET /users/{uid}/deleted?since={version}
   → For each deleted Zotero key found locally:
      - set `zotero_sync_status: removed_upstream`
      - set `removed_upstream_at` + `removed_upstream_reason`
      - keep note/assets intact for manual review
5. Update zotero_sync_state with new library_version and timestamp
6. On error: do NOT update library_version (ensures retry catches everything)
```

### Pagination
Zotero API returns max 100 items per request. Follow `Link: <url>; rel="next"` headers.

### Item Types to Process
- `journalArticle` — primary target
- `book`, `bookSection` — include
- `preprint` — include
- `conferencePaper` — include
- Skip: `note`, `attachment`, `annotation`, `webpage`, `letter`, `patent` (configurable)

### Collection Filtering
Optional: sync only specific collections
```yaml
zotero:
  collections:
    - "Adaptogens"
    - "Clinical Trials"
  # If empty/missing: sync all items
```

## 4. Sync State Persistence (Resolves F05)

```sql
-- zotero_sync_state (singleton row)
id: 1
library_version: 4287          -- Zotero's Last-Modified-Version
last_sync_at: "2026-03-25T17:00:00Z"  -- when sync was attempted
last_success_at: "2026-03-25T17:00:00Z"  -- when sync completed without error
items_synced: 15               -- items processed in last sync
sync_error: null               -- last error message (null if clean)
```

### Integrity Check
On each sync:
1. Read stored `library_version`
2. If stored version is 0: this is a first sync (full pull)
3. If stored version > 0: delta sync from that version
4. If Zotero returns 304 Not Modified: nothing to do
5. If Zotero returns items: process them, then update stored version

### Recovery from Corrupted State
If sync state is somehow corrupt (e.g., version is ahead of reality):
```bash
rhizome sync zotero --full    # force full sync, resets library_version to 0
```

## 5. Field Mapping

### Zotero → StudyRecord

| Zotero Field | StudyRecord Field | Notes |
|---|---|---|
| `key` | `zotero_key` | Zotero's item key |
| `version` | `zotero_version` | For delta detection |
| `data.title` | `title` | |
| `data.creators` (type=author) | `authors` | Map `firstName`+`lastName` → `{given, family}` |
| `data.date` | `year` | Parse year from various date formats |
| `data.publicationTitle` | `journal` | |
| `data.DOI` | `doi` | Normalize: strip `https://doi.org/` prefix |
| `data.url` | `url` | |
| `data.abstractNote` | `abstract` | |
| `data.volume` | `volume` | |
| `data.issue` | `issue` | |
| `data.pages` | `pages` | |
| `data.itemType` | `item_type` | |
| `data.extra` | `pmid` (extracted) | Parse PMID from extra field: `PMID: 12345` |
| `data.extra` | `pmcid` (extracted) | Parse PMCID from extra field: `PMCID: PMC1234567` |
| `data.tags` | `source_tags` | Array of tag objects → string array |
| `data.collections` | `source_collections` | Collection keys → resolve to names |
| `data.dateAdded` | `date_added` | |

### PMID Extraction from Extra Field
Zotero stores PMID in the `extra` field (no dedicated field):
```
PMID: 37291847
PMCID: PMC9876543
```
Parse with regex: `/PMID:\s*(\d+)/`

PMCID extraction:
Parse with regex: `/PMCID:\s*(PMC\d+)/i`

### Upstream Deletions (Manual Review Mode)
Deleted Zotero items are never hard-deleted from vault in MVP. They are flagged for review:
```yaml
zotero_sync_status: "removed_upstream"
removed_upstream_at: "2026-03-25T17:55:00Z"
removed_upstream_reason: "deleted in Zotero"
```
Users decide follow-up action manually (keep/archive/delete).

### Collection Name Resolution
Zotero API returns collection keys, not names. Cache collection tree:
```
GET /users/{uid}/collections
→ Map: { key: "ABCD1234", name: "Adaptogens" }
```

## 6. Sync Flow: Vault → Zotero (Phase 5)

**Not in MVP.** Design-for but don't build.

### Intended Flow
```
1. CLI trigger: study sync vault-to-zotero
2. Find study notes with DOI/PMID but no zotero_key
3. For each:
   a. Enrich metadata via CrossRef (DOI) or PubMed (PMID)
   b. POST to Zotero API to create item
   c. Receive zotero_key in response
   d. Write zotero_key back to study frontmatter
   e. Update studies table
```

### Conflict Resolution (Phase 5)
| Field Category | Authority | Merge Rule |
|---|---|---|
| Bibliographic (title, authors, journal, etc.) | Zotero | Zotero wins on conflict |
| Tags | Both | Additive merge (union) |
| Collections | Zotero | Zotero-authoritative |
| Classification (taxonomy, tier 1/2) | Vault | Never pushed to Zotero |
| Pipeline metadata | Vault | Internal only, never synced |

## 7. Zotero API Client

```typescript
interface DownloadResult {
  ok: boolean;
  status: number;
  bytesWritten: number;
  error?: string;
}

class ZoteroClient {
  constructor(private config: { userId: string; apiKey: string });

  // Fetch items modified since version
  async getItemsSince(version: number): AsyncGenerator<ZoteroItem>;

  // Fetch single item
  async getItem(key: string): Promise<ZoteroItem>;

  // Fetch child items (attachments, notes)
  async getChildItems(parentKey: string): Promise<ZoteroItem[]>;

  // Download PDF attachment
  async downloadAttachment(key: string, destPath: string): Promise<DownloadResult>;

  // Get collection tree
  async getCollections(): Promise<Map<string, string>>;  // key → name

  // Check API health
  async ping(): Promise<boolean>;

  // (Phase 5) Create item
  async createItem(data: ZoteroItemData): Promise<string>;  // returns key
}
```

### Rate Limiting
- Implement simple request throttle: max 1 request per 100ms
- On 429 response: wait `Retry-After` header seconds, then retry
- On 5xx: retry with exponential backoff (1s, 2s, 4s)

## 8. Testing Strategy

### Unit Tests
- Field mapper: Zotero item fixtures → expected StudyRecord
- PMID extraction from various `extra` field formats
- PMCID extraction from various `extra` field formats
- Date parsing from various Zotero date formats
- Collection name resolution

### Integration Tests (with real Zotero)
- Use a dedicated test Zotero library with 2 known studies
- Verify: first sync pulls both studies correctly
- Verify: second sync with no changes produces no new jobs
- Verify: modify one study in Zotero, sync detects the change
- Verify: delta sync works correctly (only changed items pulled)
- Verify: deleted item in Zotero is flagged as `removed_upstream` in vault metadata

### Fixtures Needed
- `zotero-item-journal.json` — typical journal article
- `zotero-item-book.json` — book with ISBN
- `zotero-item-preprint.json` — preprint with arXiv ID
- `zotero-item-no-doi.json` — item without DOI (test PMID fallback)

## 9. Implementation Steps

### Step 1 (Phase 1): Read-Only Client
- Implement `ZoteroClient` with `getItemsSince`, `getItem`, `getCollections`
- Implement field mapper
- Implement PMID/PMCID extraction
- Test against real Zotero test collection (2 studies)

### Step 2 (Phase 1): Delta Sync
- Implement `zotero_sync_state` persistence
- Implement deleted-item sync (`/deleted`) with manual-review flags
- Implement `rhizome sync zotero` command
- Wire into pipeline: synced items → enqueue for next stages
- Test: sync, verify notes created, sync again, verify no duplicates

### Step 3 (Phase 2): PDF Download
- Implement `downloadAttachment` (first source in PDF waterfall)
- Test: study with Zotero attachment downloads correctly

### Step 4 (Phase 5): Write Client
- Implement `createItem`
- Implement vault → Zotero flow
- Implement conflict resolution

## 10. Configuration

```yaml
zotero:
  enabled: true
  user_id: "12345"
  api_key: "xxxxxxxxxxxxxxxx"
  poll_interval_seconds: 300          # for future daemon mode
  collections: []                     # empty = all collections
  skip_item_types:
    - "note"
    - "attachment"
    - "annotation"
    - "webpage"
  # Phase 5:
  # webdav_url: ""
  # webdav_user: ""
  # webdav_pass: ""
```
