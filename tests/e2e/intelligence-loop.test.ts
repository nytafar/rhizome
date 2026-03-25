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

const requiredUserId = process.env.RHIZOME_E2E_ZOTERO_USER;
const requiredCollection = process.env.RHIZOME_E2E_ZOTERO_COLLECTION;
const requiredZoteroKey = process.env.ZOTERO_API_KEY;
const requiredClaudeBinary = Bun.which("claude");

const shouldRunLiveE2E = Boolean(
  requiredUserId && requiredCollection && requiredZoteroKey && requiredClaudeBinary,
);

const liveE2ETest = shouldRunLiveE2E ? test : test.skip;

const SUMMARIZER_SKILL = `You are a structured study summarizer.
Return JSON that strictly matches the provided schema.
Keep each field concise and factual.
If only abstract text is available, set source to "abstract_only".`;

describe("intelligence loop e2e", () => {
  liveE2ETest(
    "runs init -> sync zotero -> process --ai -> status with 2 real studies",
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
            zoteroUser: requiredUserId,
            zoteroKeyEnv: "ZOTERO_API_KEY",
            unpaywallEmail: "e2e@example.com",
            aiWindows: "00:00-23:59",
            timezone: "UTC",
          },
          { cwd: root },
        );

        const skillPath = join(root, ".siss", "skills", "summarizer.md");
        await Bun.write(skillPath, SUMMARIZER_SKILL);

        const syncResult = await runSyncZoteroCommand(
          {
            full: true,
            collection: [requiredCollection as string],
          },
          { cwd: root },
        );

        expect(syncResult.syncedItems).toBe(2);

        const processResult = await runProcessCommand(
          { ai: true },
          { cwd: root },
        );

        expect(processResult.mode).toBe("ai");
        expect(processResult.result.failed).toBe(0);

        const overview = await runStatusCommand({ json: true }, { cwd: root });
        expect(overview.mode).toBe("overview");
        expect(overview.overview?.totals.studies).toBe(2);

        const database = new Database({ path: join(root, ".siss", "siss.db") });
        database.init();

        const studies = database.db
          .query("SELECT citekey FROM studies ORDER BY citekey ASC;")
          .all() as Array<{ citekey: string }>;

        database.close();

        expect(studies).toHaveLength(2);

        for (const { citekey } of studies) {
          const notePath = join(vaultPath, "Research", "studies", `${citekey}.md`);
          const noteExists = await Bun.file(notePath).exists();
          expect(noteExists).toBe(true);

          const noteText = await Bun.file(notePath).text();
          const parsed = matter(noteText);
          const frontmatter = parseStudyFrontmatter(parsed.data);

          expect(frontmatter.citekey).toBe(citekey);

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
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
