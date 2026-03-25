# 04 — PDF Acquisition & Parsing Pipeline

**Version:** 0.3 | **Status:** Draft for review
**Depends on:** 00-architecture-overview, 01-schema-vault-design, 02-pipeline-queue
**Consumed by:** 05-ai-skills (parsed markdown is input to summarizer)

**Renamed from:** `04-pdf-docling.md` → `04-pdf-parsing.md`
**Key change in v0.3:** Docling-first language replaced with provider-neutral pipeline. Marker is the sole MVP parser. Multi-provider orchestration designed-in but disabled.

---

## 1. Purpose

This spec defines how Rhizome acquires PDFs and converts them to structured markdown for downstream AI processing. It covers two pipeline stages: `pdf_fetch` and `fulltext.marker`.

## 2. PDF Fetch Waterfall

Sources are tried in order. First success wins.

### MVP Sources (Phase 2)
1. **Zotero attachment** — if `zotero_key` exists and item has a PDF attachment
2. **Unpaywall** — legal, fast (~50ms), covers gold/green OA
3. **Europe PMC** — legal, direct download for PMC articles

### Future Sources (Phase 5+)
4. OpenAlex OA URL
5. Semantic Scholar
6. User-configurable plugin sources

### Removed from Core (Resolves F09)
- **Sci-Hub**: Removed from core. Can be added as a user plugin/extension.

### Source Implementation

#### 1. Zotero Attachment
```typescript
async function fetchFromZotero(study: StudyRecord, client: ZoteroClient): Promise<string | null> {
  if (!study.zotero_key) return null;

  const children = await client.getChildItems(study.zotero_key);
  const pdfAttachment = children.find(c =>
    c.data.contentType === "application/pdf"
  );
  if (!pdfAttachment) return null;

  const destPath = getAssetPath(study, "source.pdf");
  const result = await client.downloadAttachment(pdfAttachment.key, destPath);
  if (!result.ok) return null;
  return destPath;
}
```

#### 2. Unpaywall
```typescript
async function fetchFromUnpaywall(study: StudyRecord, email: string): Promise<string | null> {
  if (!study.doi) return null;

  const url = `https://api.unpaywall.org/v2/${study.doi}?email=${email}`;
  const response = await fetch(url);
  if (!response.ok) return null;

  const data = await response.json();
  const pdfUrl = data.best_oa_location?.url_for_pdf;
  if (!pdfUrl) return null;

  const destPath = getAssetPath(study, "source.pdf");
  await downloadFile(pdfUrl, destPath);
  return destPath;
}
```

#### 3. Europe PMC
```typescript
async function fetchFromEuropePMC(study: StudyRecord): Promise<string | null> {
  if (!study.pmcid) return null;

  const url = `https://europepmc.org/backend/ptpmcrender.fcgi?accid=${study.pmcid}&blobtype=pdf`;
  const destPath = getAssetPath(study, "source.pdf");

  try {
    await downloadFile(url, destPath);
    return destPath;
  } catch {
    return null;
  }
}
```

### Waterfall Orchestration
```typescript
async function fetchPDF(study: StudyRecord, config: PDFConfig): Promise<PDFResult> {
  const sources = [
    { name: "zotero",    fn: () => fetchFromZotero(study, zoteroClient) },
    { name: "unpaywall", fn: () => fetchFromUnpaywall(study, config.unpaywall_email) },
    { name: "europepmc", fn: () => fetchFromEuropePMC(study) },
  ];

  for (const { name, fn } of sources) {
    const path = await fn();
    if (path && await validatePDF(path)) {
      return { path, source: name, available: true };
    }
  }

  return { path: null, source: null, available: false };
}
```

### Rate Limiting
- Unpaywall: max 1 request/second
- Europe PMC: max 1 request/second
- Zotero: inherits from Zotero client rate limiting

### File Validation
After download:
1. Check file size > 0
2. Check first bytes are `%PDF-` (valid PDF header)
3. If validation fails: delete file, try next source

## 3. Markdown Provider Interface

PDF-to-markdown conversion is abstracted behind a provider interface. This is the architectural boundary between "how we get markdown" and "what we do with it."

```typescript
interface MarkdownProvider {
  id: string;                       // "marker" | "docling" | "grobid"
  name: string;                     // human-readable name

  // Convert PDF to markdown
  parse(pdfPath: string, outputDir: string, options?: ParseOptions): Promise<ParseResult>;

  // Check if provider is available and working
  healthcheck(): Promise<boolean>;
}

interface ParseOptions {
  pageRange?: string;               // e.g., "0,5-10,20"
  forceOcr?: boolean;
  timeout_ms?: number;
}

interface ParseResult {
  markdownPath: string;             // path to generated .md
  metadata: {
    pageCount: number;
    provider: string;               // which provider produced this
    providerVersion: string;
    parsedAt: string;               // ISO date
    hasImages: boolean;
    hasTables: boolean;
  };
}
```

### Provider Registry
```typescript
class ParserRegistry {
  private providers = new Map<string, MarkdownProvider>();

  register(provider: MarkdownProvider): void {
    this.providers.set(provider.id, provider);
  }

  // MVP: returns the single configured provider
  getActive(): MarkdownProvider {
    const id = this.config.parser.active_provider;
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Parser provider '${id}' not registered`);
    return provider;
  }
}
```

**MVP:** Only `MarkerProvider` is registered. The registry exists so adding Docling or GROBID later requires zero pipeline changes — just register a new provider and update config.

## 4. Marker Provider (MVP)

### What Marker Does
Marker converts PDF to markdown, preserving:
- Section headers and hierarchy
- Tables (as markdown tables)
- Equations (as LaTeX)
- Code blocks
- Images (extracted and linked)

It does **not** do:
- Citation/reference parsing (that's GROBID's job, future)
- Structured section classification (that's the AI classifier's job)

### Installation
```bash
uv pip install marker-pdf
```

Requires Python 3.10+ and PyTorch. No GPU required (CPU mode works, slower on large PDFs).

### Invocation
```typescript
class MarkerProvider implements MarkdownProvider {
  id = "marker";
  name = "Marker PDF";

  async parse(pdfPath: string, outputDir: string, options?: ParseOptions): Promise<ParseResult> {
    const args = [
      pdfPath,
      "--output_dir", outputDir,
      "--output_format", "markdown",
    ];

    if (options?.forceOcr) args.push("--force_ocr");
    if (options?.pageRange) args.push("--page_range", options.pageRange);

    const proc = Bun.spawn([this.markerBin, ...args], {
      timeout: options?.timeout_ms ?? this.config.timeout_ms,
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new ParseError(`Marker failed (exit ${exitCode}): ${stderr}`);
    }

    // Marker writes output to outputDir/{pdf_stem}/{pdf_stem}.md
    const stem = path.basename(pdfPath, ".pdf");
    const markdownPath = path.join(outputDir, stem, `${stem}.md`);

    return {
      markdownPath,
      metadata: {
        pageCount: await this.countPages(markdownPath),
        provider: "marker",
        providerVersion: await this.getVersion(),
        parsedAt: new Date().toISOString(),
        hasImages: await this.checkForImages(outputDir, stem),
        hasTables: await this.checkForTables(markdownPath),
      },
    };
  }

  async healthcheck(): Promise<boolean> {
    try {
      const proc = Bun.spawn([this.markerBin, "--help"]);
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  }
}
```

### Output Processing
Marker writes to `{outputDir}/{pdf_stem}/{pdf_stem}.md`. Rhizome post-processes:

1. Read Marker's output markdown
2. Prepend frontmatter (study ref, parser metadata)
3. Move images to `_assets/{citekey}/figures/` if any
4. Rewrite image paths in markdown to use vault-relative paths
5. Write final output to `_assets/{citekey}/fulltext.md`

### Canonical Output: `_assets/{citekey}/fulltext.md`
```markdown
---
note_type: study_fulltext
study_ref: smith2023ashwagandha
parser_provider: marker
parser_version: "1.6.0"
parsed_at: "2026-03-25T17:30:00Z"
page_count: 12
has_tables: true
---

{marker markdown output with rewritten image paths}
```

## 5. Python Environment (Resolves F04)

### Setup (`rhizome init`)
```bash
# Check if uv is installed
which uv || echo "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"

# Create virtual environment
uv venv .siss-env --python 3.11

# Install marker (pinned version)
uv pip install --python .siss-env "marker-pdf==1.6.0"

# Healthcheck
.siss-env/bin/marker_single --help
```

### Version Pinning
```toml
# pyproject.toml (in Rhizome data directory)
[project]
name = "siss-python-deps"
version = "0.1.0"
dependencies = [
    "marker-pdf==1.6.0",
]
```

### Runtime Resolution
```typescript
const MARKER_BIN = path.join(config.data_dir, ".siss-env/bin/marker_single");
```

**No Python in the main Bun codepath.** Marker is always a subprocess call.

## 6. Error Handling

| Error | Stage | Handling |
|---|---|---|
| PDF not found anywhere | pdf_fetch | Mark `pdf_available: false`, skip fulltext steps, queue `summarize` (abstract-only path) |
| Marker not installed | parse | Fail with clear message pointing to `rhizome init` |
| Scanned PDF (no text) | parse | Marker with `--force_ocr`; if still empty, mark error |
| Corrupted PDF | parse | Marker fails; mark error, study continues without fulltext |
| Timeout (>5 min) | parse | Kill process, mark error, retryable |
| Out of memory | parse | Marker crashes; mark error, potentially reduce via `--page_range` |

## 7. Asset Path Conventions

```
studies/_assets/{citekey}/
├── source.pdf               # original PDF
├── fulltext.md              # parsed markdown with frontmatter
├── figures/                 # extracted images (if any)
│   ├── fig1.png
│   └── fig2.png
├── summary.current.md       # latest AI summary
├── summary.v1.md            # archived
├── classify.current.json    # latest classification
├── classify.v1.json         # archived
└── debug/                   # preserved on failures
    └── raw_output.txt
```

## 8. Configuration

```yaml
parser:
  active_provider: "marker"           # only provider in MVP
  marker:
    version: "1.6.0"
    timeout_ms: 300000                # 5 minutes
    force_ocr: false                  # default; overridable per-study
    python_env: ".siss-env"
  # Future providers (not active):
  # docling:
  #   version: "2.15.0"
  #   timeout_ms: 300000
  # grobid:
  #   endpoint: "http://localhost:8070"
  #   timeout_ms: 60000

pdf:
  sources:
    - "zotero"
    - "unpaywall"
    - "europepmc"
  unpaywall_email: "your@email.com"
  download_timeout_ms: 30000
  max_file_size_mb: 100
```

## 9. Future Expansion (Not MVP)

### Adding a New Parser Provider

The entire contract for a new provider:
1. Implement `MarkdownProvider` interface
2. Register in `ParserRegistry`
3. Add config block
4. Set `active_provider` in config

No pipeline changes, no schema changes, no CLI changes.

### GROBID Citation Enrichment (Future Step A)
- Adds a new pipeline stage `citation_enriched` between `fulltext.marker` and `summarize`
- Runs GROBID against the PDF to extract structured references
- Output: citation graph JSON in `_assets/{citekey}/citations.json`
- Enriches fulltext.md with structured reference links
- Stage is optional/skippable — studies process without it by default

### Docling Table Recovery (Future Step B)
- Not a pipeline stage — runs as selective reprocess
- Triggered when: summarizer flags `tables_need_review: true`, or manual `rhizome reprocess --stage parse --provider docling`
- Output: improved table markdown, merged into `fulltext.md`
- Original Marker output preserved as `fulltext.marker.md` for diff

### Multi-Provider Orchestration (Future)
When multiple providers are active, the pipeline could:
- Run Marker (fast, good general quality)
- Run GROBID (citations only)
- Merge outputs into a single enriched fulltext
- This orchestration layer doesn't exist in MVP but the provider interface supports it

## 10. Implementation Steps

### Step 1 (Phase 2): PDF Fetch
- Implement Unpaywall API client
- Implement Zotero attachment download
- Implement Europe PMC download
- Implement waterfall orchestration + file validation
- Wire into pipeline as `pdf_fetch` stage
- **Test:** fetch PDF for 2 test studies by DOI/PMCID

### Step 2 (Phase 2): Provider Interface
- Define `MarkdownProvider` interface
- Define `ParseResult` type
- Implement `ParserRegistry` with single-provider active mode

### Step 3 (Phase 2): Marker Provider
- Implement `MarkerProvider`
- Implement output post-processing (frontmatter, image relocation)
- Implement Python env setup in `rhizome init`
- Wire into pipeline as `fulltext.marker` stage
- **Test:** PDF → Marker → fulltext.md in `_assets/` for 2 test studies

### Step 4 (Phase 2): Error Handling
- Implement timeout and crash recovery
- Implement OCR fallback for scanned PDFs
- Implement abstract-only pathway (no PDF available)
- **Test:** simulate various failure modes

### Testing Strategy
- Mock HTTP responses for Unpaywall/EuropePMC
- Real Zotero attachment download against test library
- Sample PDFs: one clean journal article, one scanned, one with complex tables
- Marker output snapshot tests
- Provider interface contract tests (verify any provider produces valid ParseResult)
