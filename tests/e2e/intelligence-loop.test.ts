import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../src/db/database";
import { parseStudyFrontmatter } from "../../src/schema/frontmatter";
import { runInitCommand } from "../../src/cli/commands/init";
import { runSyncZoteroCommand } from "../../src/cli/commands/sync";
import { runProcessCommand } from "../../src/cli/commands/process";
import { runStatusCommand } from "../../src/cli/commands/status";
import { runLivePreflight } from "./support/live-preflight";
import { captureSummarizeFailureEvidence } from "./support/evidence";
import { discoverWorkspaceConfig } from "../../src/config/workspace-contract";
import { runVaultWriteStage } from "../../src/stages/vault-write";
import {
  PipelineOverallStatus,
  PipelineStep,
  PipelineStepStatus,
} from "../../src/types/pipeline";
import type { StudyRecord } from "../../src/types/study";

const livePreflight = await runLivePreflight();
if (!livePreflight.ok) {
  console.warn(`[intelligence-loop:e2e] live test skipped: ${livePreflight.reason}`);
}

const liveE2ETest = livePreflight.ok ? test : test.skip;
const liveTestName = livePreflight.ok
  ? "runs init -> sync zotero -> process --ai -> status with 2 real studies"
  : `runs init -> sync zotero -> process --ai -> status with 2 real studies (preflight skipped: ${livePreflight.reason})`;

const SUMMARIZER_SKILL = `You are a structured study summarizer.
Return JSON that strictly matches the provided schema.
Keep each field concise and factual.
If only abstract text is available, set source to "abstract_only".`;

function appendEvidence(message: string, evidence: Awaited<ReturnType<typeof captureSummarizeFailureEvidence>>): string {
  if (!evidence) {
    return `${message}\nNo summarize failure evidence was captured.`;
  }

  const debugPaths =
    evidence.debugPaths.length > 0
      ? evidence.debugPaths.map((path) => `- ${path}`).join("\n")
      : "- <none found in summarize error messages>";

  return [
    message,
    `Failure artifacts: ${evidence.artifactDir}`,
    `Failure manifest: ${evidence.manifestPath}`,
    "Summarize debug paths:",
    debugPaths,
  ].join("\n");
}

describe("intelligence loop e2e", () => {
  test("preserves user frontmatter fields across repeated vault_write runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "rhizome-frontmatter-preserve-"));

    try {
      const vaultPath = join(root, "vault");
      await mkdir(vaultPath, { recursive: true });

      await runInitCommand(
        {
          nonInteractive: true,
          force: true,
          vault: vaultPath,
          researchRoot: "Research",
          zoteroUser: "0",
          zoteroKeyEnv: "ZOTERO_API_KEY",
          unpaywallEmail: "e2e@example.com",
          aiWindows: "00:00-23:59",
          timezone: "UTC",
        },
        { cwd: root },
      );

      const workspaceConfig = await discoverWorkspaceConfig(root);
      if (workspaceConfig.kind === "missing") {
        throw new Error(workspaceConfig.guidance);
      }

      const database = new Database({ path: join(workspaceConfig.workspaceDir, "siss.db") });
      database.init();

      const rhizomeId = "550e8400-e29b-41d4-a716-446655440000";
      const citekey = "preserve2026demo";
      const pipelineSteps = {
        [PipelineStep.INGEST]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-26T21:00:00Z",
          retries: 0,
        },
        [PipelineStep.ZOTERO_SYNC]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-26T21:01:00Z",
          retries: 0,
        },
        [PipelineStep.SUMMARIZE]: {
          status: PipelineStepStatus.COMPLETE,
          updated_at: "2026-03-26T21:02:00Z",
          retries: 0,
        },
      };

      database.db
        .query(
          `
          INSERT INTO studies (rhizome_id, citekey, source, title, pipeline_overall, pipeline_steps_json)
          VALUES (?, ?, ?, ?, ?, ?);
          `,
        )
        .run(
          rhizomeId,
          citekey,
          "manual",
          "Frontmatter Preserve Baseline",
          PipelineOverallStatus.IN_PROGRESS,
          JSON.stringify(pipelineSteps),
        );

      const baseStudy: StudyRecord = {
        siss_id: rhizomeId,
        rhizome_id: rhizomeId,
        citekey,
        title: "Frontmatter Preserve Baseline",
        authors: [{ family: "Tester", given: "E2E" }],
        year: 2026,
        pipeline_overall: PipelineOverallStatus.IN_PROGRESS,
        pipeline_steps: pipelineSteps,
        pipeline_error: null,
        source: "manual",
        source_tags: ["auto-generated"],
        pdf_available: false,
        last_pipeline_run: "2026-03-26",
      };

      const vaultConfig = {
        research_root: "Research",
        studies_folder: "studies",
        assets_folder: "_assets",
      } as const;

      await runVaultWriteStage({
        db: database.db,
        study: baseStudy,
        vaultPath,
        vault: vaultConfig,
      });

      const notePath = join(vaultPath, "Research", "studies", `${citekey}.md`);
      const firstParsed = matter(await Bun.file(notePath).text());
      const firstFrontmatter = parseStudyFrontmatter(firstParsed.data);
      expect(firstFrontmatter.tags).toEqual(["auto-generated"]);

      const editedData = {
        ...firstParsed.data,
        tags: ["my-tag", "keep-me"],
        user_rating: 5,
        user_status: "reading",
        notes: "manual annotation",
        user_note: "[[Research/study-notes/preserve2026demo.note|Notes]]",
      };
      await Bun.write(notePath, matter.stringify(firstParsed.content, editedData));

      const secondStudy: StudyRecord = {
        ...baseStudy,
        title: "Frontmatter Preserve Updated",
      };

      await runVaultWriteStage({
        db: database.db,
        study: secondStudy,
        vaultPath,
        vault: vaultConfig,
      });

      const secondParsed = matter(await Bun.file(notePath).text());
      const secondFrontmatter = parseStudyFrontmatter(secondParsed.data);

      expect(secondFrontmatter.title).toBe("Frontmatter Preserve Updated");
      expect(secondFrontmatter.tags).toEqual(["my-tag", "keep-me"]);
      expect(secondFrontmatter.user_rating).toBe(5);
      expect(secondFrontmatter.user_status).toBe("reading");
      expect(secondFrontmatter.notes).toBe("manual annotation");
      expect(secondFrontmatter.user_note).toBe("[[Research/study-notes/preserve2026demo.note|Notes]]");

      database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  liveE2ETest(
    liveTestName,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rhizome-intelligence-loop-"));

      try {
        const vaultPath = join(root, "vault");
        await mkdir(vaultPath, { recursive: true });

        await runInitCommand(
          {
            nonInteractive: true,
            force: true,
            vault: vaultPath,
            researchRoot: "Research",
            zoteroUser: process.env.RHIZOME_E2E_ZOTERO_USER,
            zoteroKeyEnv: "ZOTERO_API_KEY",
            unpaywallEmail: "e2e@example.com",
            aiWindows: "00:00-23:59",
            timezone: "UTC",
          },
          { cwd: root },
        );

        const workspaceConfig = await discoverWorkspaceConfig(root);
        if (workspaceConfig.kind === "missing") {
          throw new Error(workspaceConfig.guidance);
        }

        const skillPath = join(workspaceConfig.workspaceDir, "skills", "summarizer.md");
        await Bun.write(skillPath, SUMMARIZER_SKILL);

        const syncResult = await runSyncZoteroCommand(
          {
            full: true,
            collection: [process.env.RHIZOME_E2E_ZOTERO_COLLECTION as string],
          },
          { cwd: root },
        );

        expect(syncResult.syncedItems).toBe(2);

        const processResult = await runProcessCommand(
          { ai: true },
          { cwd: root },
        );

        expect(processResult.mode).toBe("ai");

        if (processResult.result.failed !== 0) {
          const evidence = await captureSummarizeFailureEvidence(root);
          const message = appendEvidence(
            `Expected process --ai to succeed with failed=0, received failed=${processResult.result.failed}.`,
            evidence,
          );
          throw new Error(message);
        }

        const overview = await runStatusCommand({ json: true }, { cwd: root });
        expect(overview.mode).toBe("overview");
        expect(overview.overview?.totals.studies).toBe(2);

        const database = new Database({ path: join(workspaceConfig.workspaceDir, "siss.db") });
        database.init();

        const studies = database.db
          .query("SELECT citekey, doi, pmid, rhizome_id FROM studies ORDER BY citekey ASC;")
          .all() as Array<{ citekey: string; doi: string | null; pmid: string | null; rhizome_id: string }>;

        database.close();

        expect(studies).toHaveLength(2);

        for (const { citekey, doi, pmid, rhizome_id } of studies) {
          const notePath = join(vaultPath, "Research", "studies", `${citekey}.md`);
          const noteExists = await Bun.file(notePath).exists();
          expect(noteExists).toBe(true);

          const noteText = await Bun.file(notePath).text();
          const parsed = matter(noteText);
          const frontmatter = parseStudyFrontmatter(parsed.data);

          expect(frontmatter.note_type).toBe("study");
          expect(frontmatter.has_summary).toBe(true);

          if (!doi && !pmid) {
            expect(frontmatter.rhizome_id).toBe(rhizome_id);
          }

          const summaryPath = join(
            vaultPath,
            "Research",
            "studies",
            "_assets",
            citekey,
            "summary.current.md",
          );
          const summaryExists = await Bun.file(summaryPath).exists();
          expect(summaryExists).toBe(true);

          const detail = await runStatusCommand(
            { citekey, json: true },
            { cwd: root },
          );

          expect(detail.mode).toBe("study");
          expect(["complete", "in_progress"]).toContain(detail.study?.pipeline_overall);

          const summarizeState = detail.study?.pipeline_steps.summarize as
            | { status?: string }
            | undefined;
          expect(summarizeState?.status).toBe("complete");
        }
      } catch (error) {
        const evidence = await captureSummarizeFailureEvidence(root);
        const baseMessage = error instanceof Error ? error.message : String(error);
        throw new Error(appendEvidence(baseMessage, evidence), {
          cause: error,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
