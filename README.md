<p align="center">
  <img src="docs/rhizome-logo.svg" alt="Rhizome" width="120" />
</p>

<h1 align="center">Rhizome</h1>

<p align="center">
  <strong>Research intelligence pipeline for Obsidian</strong><br/>
  Sync your Zotero library, fetch PDFs, extract full text, and enrich every study with AI-generated summaries and structured classifications — all inside your Obsidian vault.
</p>

<p align="center">
  <a href="#what-rhizome-does">What it does</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#getting-started">Getting started</a> &middot;
  <a href="#running-as-a-service">Running as a service</a> &middot;
  <a href="#commands">Commands</a> &middot;
  <a href="#specs">Specs</a>
</p>

---

## What Rhizome Does

If you use Zotero to manage academic papers and Obsidian to think, Rhizome is the bridge that makes them work together — and adds intelligence on top.

**Without Rhizome**, you manually create notes for each paper, copy-paste abstracts, tag things inconsistently, and lose track of what you've actually read.

**With Rhizome**, every study in your Zotero library becomes a richly structured Obsidian note — with AI summaries, classified metadata, full-text markdown, and queryable frontmatter — automatically.

### What you get

- **Structured study notes** in your vault with consistent frontmatter (authors, DOI, year, journal, study type, and more)
- **AI-generated summaries** that go beyond the abstract — written from the full text when available, with key findings, methodology, and clinical relevance
- **Structured classifications** — therapeutic areas, mechanisms of action, dosages, contraindications, research gaps — extracted by AI and organized into an evolving taxonomy
- **Full-text markdown** extracted from PDFs, right in your vault, searchable and linkable
- **Obsidian Bases views** — queryable tables of your entire library, filterable by status, topic, study type, or anything in your taxonomy
- **An audit trail** — every processing step is logged, versioned, and inspectable

### Who it's for

Researchers, clinicians, supplement scientists, and anyone building a personal knowledge base from academic literature. Rhizome is designed for libraries of hundreds to thousands of studies, with a pipeline that processes them in manageable batches during off-peak hours.

---

## How It Works

Rhizome is a CLI tool — not a plugin, not a web service. It runs on your machine, reads from Zotero's API, writes to your Obsidian vault as plain files, and uses Claude as an AI engine for summarization and classification.

```
Zotero  ──→  Rhizome  ──→  Obsidian Vault
  │            │  │            │
  │  metadata  │  │  notes     │  You read, link, annotate
  │  PDFs      │  │  summaries │  in Obsidian as usual
  │            │  │  metadata  │
  │            │  │            │
  │            │  └──→ SQLite  │  Pipeline state, job queue,
  │            │       (.siss/)│  audit log, sync state
  │            │               │
  │            └──→ Claude     │  AI summaries + classification
  │                 (CLI)      │  during configured time windows
```

### The pipeline

Each study moves through a series of stages, each independently rerunnable:

1. **Ingest** — normalize metadata from Zotero (or future sources) into a StudyRecord
2. **PDF fetch** — try Zotero attachments, then Unpaywall, then Europe PMC
3. **Parse** — convert PDF to searchable markdown via Marker
4. **Summarize** — Claude reads the full text and writes a structured summary
5. **Classify** — Claude extracts structured metadata (species, dosages, mechanisms, study design) into your taxonomy
6. **Vault write** — render the final Obsidian note with frontmatter
7. **Bases sync** — regenerate queryable table views

AI stages run during configurable time windows (e.g., early morning, evening) to respect Claude usage limits. Everything else runs immediately.

### AI strategy

Rhizome uses a **piped** approach by default: the summarizer reads the full text and produces both a human summary and a structured extraction section. The classifier then reads only the condensed summary (~2K tokens) instead of the full paper (~50-100K tokens), making classification fast and cheap while maintaining accuracy. Two alternative strategies (two-pass and single-pass) are designed in for benchmarking.

---

## Tech Overview

| Layer | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh) (TypeScript, native SQLite) |
| State | SQLite via `bun:sqlite` — single file, zero config |
| AI engine | [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) with structured JSON output |
| PDF parsing | [Marker](https://github.com/VikParuchuri/marker) (Python sidecar via `uv`) |
| Reference manager | [Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/start) |
| Vault | [Obsidian](https://obsidian.md) (plain markdown + YAML frontmatter) |
| Config validation | [Zod](https://zod.dev) schemas with versioned migrations |

Key architectural choices:

- **SQLite is the system of record** for all machine state. Frontmatter is a read-only projection — the vault is always regenerable from the database.
- **Single-writer mutation model** — only one pipeline process runs at a time, enforced by lockfile. No race conditions, no corruption.
- **Provider interfaces** — PDF parsing is abstracted behind a `MarkdownProvider` interface. Marker is the MVP parser; GROBID and Docling can be added later without pipeline changes.
- **Everything is auditable** — every stage transition is logged with timing, errors, and metadata.

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (for AI features)
- [Python 3.10+](https://www.python.org/) and [uv](https://astral.sh/uv) (for PDF parsing)
- A [Zotero account](https://www.zotero.org/) with an API key
- An [Obsidian](https://obsidian.md) vault

### Install

```bash
# Clone the repository
git clone https://github.com/nytafar/rhizome.git
cd rhizome

# Install dependencies
bun install

# Link the CLI globally (optional — lets you run `rhizome` from anywhere)
bun link
```

Or run directly without installing:

```bash
# Using bunx (Bun's npx equivalent)
bunx rhizome init
bunx rhizome sync zotero
bunx rhizome status
```

### Setup

```bash
# Interactive setup — walks you through vault path, Zotero credentials,
# AI windows, and PDF parser installation
rhizome init

# Or non-interactive
rhizome init \
  --vault ~/Documents/Vault \
  --zotero-user 12345 \
  --zotero-key-env ZOTERO_API_KEY \
  --unpaywall-email you@example.com \
  --ai-windows "17:00-19:00,23:00-01:00,04:00-06:00" \
  --timezone "Europe/Oslo"
```

`rhizome init` creates the folder structure in your vault, writes the config, sets up the Python environment for Marker, and runs a healthcheck.

### First sync

```bash
# Pull your Zotero library
rhizome sync zotero

# Fetch PDFs and parse to markdown
rhizome process

# Run AI summarization (during configured windows, or use --now to skip)
rhizome process --ai --now

# Check progress
rhizome status
```

---

## Running as a Service

Rhizome is a CLI tool by design — it doesn't need to run continuously. But you'll want it to run on a schedule so new Zotero additions are automatically synced and processed.

### macOS (launchd)

Create `~/Library/LaunchAgents/no.nyta.rhizome.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>no.nyta.rhizome</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/lasse/.bun/bin/rhizome</string>
    <string>sync</string>
    <string>zotero</string>
  </array>
  <key>StartInterval</key>
  <integer>1800</integer> <!-- every 30 minutes -->
  <key>StandardOutPath</key>
  <string>/tmp/rhizome-sync.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/rhizome-sync.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ZOTERO_API_KEY</key>
    <string>your-api-key</string>
  </dict>
</dict>
</plist>
```

Then load it:

```bash
launchctl load ~/Library/LaunchAgents/no.nyta.rhizome.plist
```

For AI processing, create a second agent that runs `rhizome process --ai` — it will automatically respect your configured time windows and skip if outside them.

### Linux (systemd)

Create `~/.config/systemd/user/rhizome-sync.service`:

```ini
[Unit]
Description=Rhizome Zotero Sync

[Service]
Type=oneshot
ExecStart=%h/.bun/bin/rhizome sync zotero
Environment=ZOTERO_API_KEY=your-api-key
```

And `~/.config/systemd/user/rhizome-sync.timer`:

```ini
[Unit]
Description=Run Rhizome sync every 30 minutes

[Timer]
OnCalendar=*:0/30
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now rhizome-sync.timer
```

### cron (universal)

```bash
# Sync every 30 minutes
*/30 * * * * ZOTERO_API_KEY=your-key ~/.bun/bin/rhizome sync zotero >> /tmp/rhizome.log 2>&1

# Run AI processing every hour (respects configured windows internally)
0 * * * * ZOTERO_API_KEY=your-key ~/.bun/bin/rhizome process --ai >> /tmp/rhizome-ai.log 2>&1
```

---

## Commands

```bash
rhizome init                          # Interactive setup wizard
rhizome sync zotero                   # Pull changes from Zotero
rhizome process                       # Run non-AI pipeline stages
rhizome process --ai                  # Run AI stages (respects time windows)
rhizome process --ai --now            # Run AI stages immediately
rhizome status                        # Pipeline overview
rhizome status --citekey smith2023    # Detail for one study
rhizome reprocess --stage summarize   # Rerun summaries (e.g., after skill update)
rhizome retry --all-failed            # Retry all failed studies
rhizome taxonomy status               # View classification taxonomy
rhizome taxonomy review               # Review pending taxonomy proposals
rhizome audit --citekey smith2023     # Full processing history
```

Every command supports `--json` for machine-readable output — Rhizome is designed to be invoked by agents as easily as by humans.

---

## Project Structure

```
your-vault/
├── Research/
│   ├── studies/
│   │   ├── smith2023ashwagandha.md       # Study note (frontmatter + summary link)
│   │   └── jones2024curcumin.md
│   ├── _assets/
│   │   ├── smith2023ashwagandha/
│   │   │   ├── source.pdf                 # Original PDF
│   │   │   ├── fulltext.md                # Parsed markdown
│   │   │   ├── summary.current.md         # AI summary (latest)
│   │   │   └── classify.current.json      # Classification output
│   │   └── jones2024curcumin/
│   ├── study-notes/                        # Your manual notes (never touched)
│   └── _system/
│       ├── taxonomy.json                   # Evolving classification system
│       ├── studies.base                    # Obsidian Bases view
│       └── review-queue.base
└── .siss/
    ├── siss.db                             # SQLite (system of record)
    ├── config.yaml                         # Configuration
    └── skills/                             # AI skill prompts
        ├── summarizer.md
        └── classifier.md
```

---

## Specs

Detailed architecture and design specs are in [`specs-v3/`](specs-v3/README.md):

| Spec | Purpose |
|---|---|
| 00 — Architecture Overview | System boundaries, principles, tech stack |
| 01 — Schema & Vault Design | Data contract, frontmatter, folder structure |
| 02 — Pipeline & Queue | Job queue, state machine, AI time windows |
| 03 — Zotero Sync | Zotero API integration, delta sync |
| 04 — PDF Parsing | PDF acquisition, Marker provider |
| 05 — AI Skills | Claude Code invocation, summarizer, classifier |
| 06 — Taxonomy | Self-improving classification system |
| 07 — CLI & Config | Commands, configuration, setup flow |

---

## Status

Rhizome is in active development. The spec suite is stable and implementation is beginning with Phase 1 (Zotero sync + abstract-only AI summaries).

---

## Author

**Lasse Jellum** ([@nytafar](https://github.com/nytafar))

---

## License

AGPL-3.0
