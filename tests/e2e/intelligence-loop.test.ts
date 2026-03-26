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
