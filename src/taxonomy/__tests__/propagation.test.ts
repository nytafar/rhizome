import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../db/database";
import { TaxonomyManager } from "../manager";
import { applyApprovedTaxonomyDecisions } from "../propagation";
import { classifierTaxonomyGroups } from "../../ai/schemas/classifier";
import { createEmptyTaxonomyState } from "../schema";

async function withTempWorkspace<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "rhizome-taxonomy-propagation-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function taxonomyPath(root: string): string {
  return join(root, "vault", "Research", "_system", "taxonomy.json");
}

function notePath(root: string, fileName: string): string {
  return join(root, "vault", "Research", "studies", fileName);
}

async function writeValidStudy(params: {
  root: string;
  fileName: string;
  group: "therapeutic_areas" | "mechanisms";
  value: string;
}): Promise<void> {
  await writeFile(
    notePath(params.root, params.fileName),
    matter.stringify("# Study\n", {
      note_type: "study",
      has_pdf: false,
      has_fulltext: false,
      has_summary: false,
      has_classification: true,
      pipeline_status: "partial",
      title: params.fileName,
      authors: [{ family: "Lane", given: "A" }],
      year: 2026,
      pdf_available: false,
      tier_6_taxonomy: {
        therapeutic_areas: params.group === "therapeutic_areas" ? [params.value] : [],
        mechanisms: params.group === "mechanisms" ? [params.value] : [],
        indications: [],
        contraindications: [],
        drug_interactions: [],
        research_gaps: [],
      },
      tier_7_provisional: [
        {
          group: params.group,
          value: `new:${params.value}`,
          confidence: 0.9,
          proposed_by: "classifier",
          logged_at: "2026-03-27T00:00:00.000Z",
        },
      ],
    }),
    "utf8",
  );
}

function insertDecision(params: {
  db: Database;
  proposalId: string;
  operation: "rename" | "merge";
  group: string;
  source: string;
  target: string;
  status: "approved" | "rejected";
}): void {
  params.db.db
    .query(
      `
      INSERT INTO taxonomy_proposal_decisions (
        proposal_id,
        operation_type,
        group_name,
        source_value,
        target_value,
        decision_status,
        decided_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `,
    )
    .run(
      params.proposalId,
      params.operation,
      params.group,
      params.source,
      params.target,
      params.status,
      "2026-03-27T00:00:00.000Z",
      "2026-03-27T00:00:00.000Z",
    );
}

describe("taxonomy propagation", () => {
  test("applies approved decisions, updates checkpoint, and is idempotent on rerun", async () => {
    await withTempWorkspace(async (root) => {
      const vaultPath = join(root, "vault");
      await mkdir(join(vaultPath, "Research", "_system"), { recursive: true });
      await mkdir(join(vaultPath, "Research", "studies"), { recursive: true });

      const manager = new TaxonomyManager({
        filePath: taxonomyPath(root),
        groups: [...classifierTaxonomyGroups],
      });

      const taxonomyState = createEmptyTaxonomyState([...classifierTaxonomyGroups]);
      taxonomyState.groups.mechanisms.pending.hpa_axis_resilience = {
        count: 2,
        first_seen_at: "2026-03-27T00:00:00.000Z",
        last_seen_at: "2026-03-27T00:00:00.000Z",
        sources: ["classifier"],
      };
      await manager.save(taxonomyState);

      await writeValidStudy({
        root,
        fileName: "a.md",
        group: "mechanisms",
        value: "hpa_axis_resilience",
      });

      const database = new Database({ path: join(root, "rhizome.sqlite") });
      database.init();

      insertDecision({
        db: database,
        proposalId: "proposal:mechanisms:rename:hpa_axis_resilience",
        operation: "rename",
        group: "mechanisms",
        source: "hpa_axis_resilience",
        target: "hpa_axis_regulation",
        status: "approved",
      });

      const first = await applyApprovedTaxonomyDecisions({
        db: database.db,
        taxonomyManager: manager,
        vaultPath,
        researchRoot: "Research",
      });

      expect(first.decisions).toHaveLength(1);
      expect(first.decisions[0]?.status).toBe("completed");

      const note = matter(await readFile(notePath(root, "a.md"), "utf8")).data as {
        tier_6_taxonomy: { mechanisms: string[] };
        tier_7_provisional: unknown[];
      };
      expect(note.tier_6_taxonomy.mechanisms).toEqual(["hpa_axis_regulation"]);
      expect(note.tier_7_provisional).toEqual([]);

      const second = await applyApprovedTaxonomyDecisions({
        db: database.db,
        taxonomyManager: manager,
        vaultPath,
        researchRoot: "Research",
      });
      expect(second.decisions[0]?.status).toBe("skipped");

      const checkpoint = database.db
        .query(
          `
          SELECT status, processed_notes, total_notes
          FROM taxonomy_propagation_checkpoints
          WHERE proposal_id = ?
          LIMIT 1;
          `,
        )
        .get("proposal:mechanisms:rename:hpa_axis_resilience") as {
        status: string;
        processed_notes: number;
        total_notes: number;
      };
      expect(checkpoint.status).toBe("completed");
      expect(checkpoint.processed_notes).toBe(1);
      expect(checkpoint.total_notes).toBe(1);

      database.close();
    });
  });

  test("resume continues from checkpoint after simulated mid-apply crash", async () => {
    await withTempWorkspace(async (root) => {
      const vaultPath = join(root, "vault");
      await mkdir(join(vaultPath, "Research", "_system"), { recursive: true });
      await mkdir(join(vaultPath, "Research", "studies"), { recursive: true });

      const manager = new TaxonomyManager({
        filePath: taxonomyPath(root),
        groups: [...classifierTaxonomyGroups],
      });

      const taxonomyState = createEmptyTaxonomyState([...classifierTaxonomyGroups]);
      taxonomyState.groups.therapeutic_areas.pending.stress_resilience = {
        count: 1,
        first_seen_at: "2026-03-27T00:00:00.000Z",
        last_seen_at: "2026-03-27T00:00:00.000Z",
        sources: ["classifier"],
      };
      await manager.save(taxonomyState);

      await writeValidStudy({
        root,
        fileName: "a.md",
        group: "therapeutic_areas",
        value: "stress_resilience",
      });
      await writeValidStudy({
        root,
        fileName: "b.md",
        group: "therapeutic_areas",
        value: "stress_resilience",
      });

      const database = new Database({ path: join(root, "rhizome.sqlite") });
      database.init();
      insertDecision({
        db: database,
        proposalId: "proposal:therapeutic_areas:rename:stress_resilience",
        operation: "rename",
        group: "therapeutic_areas",
        source: "stress_resilience",
        target: "stress_support",
        status: "approved",
      });

      await expect(
        applyApprovedTaxonomyDecisions({
          db: database.db,
          taxonomyManager: manager,
          vaultPath,
          researchRoot: "Research",
          options: {
            batchSize: 1,
            beforeNoteRewrite: ({ noteIndex }) => {
              if (noteIndex === 1) {
                throw new Error("simulated crash");
              }
            },
          },
        }),
      ).rejects.toThrow("simulated crash");

      const errored = database.db
        .query(
          `
          SELECT status, processed_notes, total_notes
          FROM taxonomy_propagation_checkpoints
          WHERE proposal_id = ?
          LIMIT 1;
          `,
        )
        .get("proposal:therapeutic_areas:rename:stress_resilience") as {
        status: string;
        processed_notes: number;
        total_notes: number;
      };
      expect(errored.status).toBe("error");
      expect(errored.processed_notes).toBe(1);

      const resumed = await applyApprovedTaxonomyDecisions({
        db: database.db,
        taxonomyManager: manager,
        vaultPath,
        researchRoot: "Research",
        options: {
          resume: true,
        },
      });

      expect(resumed.decisions[0]?.status).toBe("completed");

      const noteA = matter(await readFile(notePath(root, "a.md"), "utf8")).data as {
        tier_6_taxonomy: { therapeutic_areas: string[] };
      };
      const noteB = matter(await readFile(notePath(root, "b.md"), "utf8")).data as {
        tier_6_taxonomy: { therapeutic_areas: string[] };
      };
      expect(noteA.tier_6_taxonomy.therapeutic_areas).toEqual(["stress_support"]);
      expect(noteB.tier_6_taxonomy.therapeutic_areas).toEqual(["stress_support"]);

      database.close();
    });
  });

  test("fails safely on malformed frontmatter and records checkpoint error", async () => {
    await withTempWorkspace(async (root) => {
      const vaultPath = join(root, "vault");
      await mkdir(join(vaultPath, "Research", "_system"), { recursive: true });
      await mkdir(join(vaultPath, "Research", "studies"), { recursive: true });

      const manager = new TaxonomyManager({
        filePath: taxonomyPath(root),
        groups: [...classifierTaxonomyGroups],
      });
      const taxonomyState = createEmptyTaxonomyState([...classifierTaxonomyGroups]);
      taxonomyState.groups.mechanisms.pending.hpa_axis_resilience = {
        count: 1,
        first_seen_at: "2026-03-27T00:00:00.000Z",
        last_seen_at: "2026-03-27T00:00:00.000Z",
        sources: ["classifier"],
      };
      await manager.save(taxonomyState);

      await writeFile(notePath(root, "broken.md"), "---\ntitle: broken\n", "utf8");

      const database = new Database({ path: join(root, "rhizome.sqlite") });
      database.init();

      insertDecision({
        db: database,
        proposalId: "proposal:mechanisms:rename:hpa_axis_resilience",
        operation: "rename",
        group: "mechanisms",
        source: "hpa_axis_resilience",
        target: "hpa_axis_resilience",
        status: "approved",
      });

      await expect(
        applyApprovedTaxonomyDecisions({
          db: database.db,
          taxonomyManager: manager,
          vaultPath,
          researchRoot: "Research",
        }),
      ).rejects.toThrow("Malformed frontmatter");

      const checkpoint = database.db
        .query(
          `
          SELECT status, last_error
          FROM taxonomy_propagation_checkpoints
          WHERE proposal_id = ?
          LIMIT 1;
          `,
        )
        .get("proposal:mechanisms:rename:hpa_axis_resilience") as { status: string; last_error: string | null };

      expect(checkpoint.status).toBe("error");
      expect(checkpoint.last_error).toContain("Malformed frontmatter");

      database.close();
    });
  });

  test("handles zero affected studies and mixed approved/rejected decisions", async () => {
    await withTempWorkspace(async (root) => {
      const vaultPath = join(root, "vault");
      await mkdir(join(vaultPath, "Research", "_system"), { recursive: true });
      await mkdir(join(vaultPath, "Research", "studies"), { recursive: true });

      const manager = new TaxonomyManager({
        filePath: taxonomyPath(root),
        groups: [...classifierTaxonomyGroups],
      });
      await manager.save(createEmptyTaxonomyState([...classifierTaxonomyGroups]));

      const database = new Database({ path: join(root, "rhizome.sqlite") });
      database.init();

      insertDecision({
        db: database,
        proposalId: "proposal:mechanisms:rename:unused",
        operation: "rename",
        group: "mechanisms",
        source: "unused",
        target: "used",
        status: "approved",
      });
      insertDecision({
        db: database,
        proposalId: "proposal:mechanisms:rename:ignored",
        operation: "rename",
        group: "mechanisms",
        source: "ignored",
        target: "kept",
        status: "rejected",
      });

      const result = await applyApprovedTaxonomyDecisions({
        db: database.db,
        taxonomyManager: manager,
        vaultPath,
        researchRoot: "Research",
      });

      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]?.totalNotes).toBe(0);

      database.close();
    });
  });
});
