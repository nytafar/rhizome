import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../../src/db/database";
import { discoverWorkspaceConfig } from "../../../src/config/workspace-contract";
import { PipelineStep } from "../../../src/types/pipeline";

interface SummarizeFailureRow {
  citekey: string;
  errorMessage: string | null;
  completedAt: string | null;
}

export interface SummarizeFailureEvidence {
  artifactDir: string;
  manifestPath: string;
  debugPaths: string[];
}

function extractDebugPath(errorMessage: string | null): string | undefined {
  if (!errorMessage) {
    return undefined;
  }

  const match = errorMessage.match(/Debug:\s*([^\n]+)/i);
  const path = match?.[1]?.trim();
  return path && path.length > 0 ? path : undefined;
}

export async function captureSummarizeFailureEvidence(root: string): Promise<SummarizeFailureEvidence | null> {
  const workspaceConfig = await discoverWorkspaceConfig(root);
  if (workspaceConfig.kind === "missing") {
    return null;
  }

  const dbPath = join(workspaceConfig.workspaceDir, "siss.db");
  if (!(await Bun.file(dbPath).exists())) {
    return null;
  }

  const database = new Database({ path: dbPath });
  database.init();

  try {
    const rows = database.db
      .query(
        `
          SELECT s.citekey AS citekey, j.error_message AS errorMessage, j.completed_at AS completedAt
          FROM jobs j
          JOIN studies s ON s.siss_id = j.siss_id
          WHERE j.stage = ?
            AND j.status = 'error'
          ORDER BY j.id DESC;
        `,
      )
      .all(PipelineStep.SUMMARIZE) as SummarizeFailureRow[];

    if (rows.length === 0) {
      return null;
    }

    const artifactDir = await mkdtemp(join(tmpdir(), "rhizome-e2e-failure-"));
    const copiedDebugDir = join(artifactDir, "debug");
    await mkdir(copiedDebugDir, { recursive: true });

    const copiedDebugPaths: string[] = [];
    const rawDebugPaths = new Set<string>();

    for (const [index, row] of rows.entries()) {
      const debugPath = extractDebugPath(row.errorMessage);
      if (!debugPath) {
        continue;
      }

      rawDebugPaths.add(debugPath);

      if (!(await Bun.file(debugPath).exists())) {
        continue;
      }

      const targetPath = join(copiedDebugDir, `${index + 1}-${row.citekey}-${basename(debugPath)}`);
      await copyFile(debugPath, targetPath);
      copiedDebugPaths.push(targetPath);
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      root,
      dbPath,
      summarizeFailures: rows.map((row) => ({
        citekey: row.citekey,
        completedAt: row.completedAt,
        errorMessage: row.errorMessage,
        debugPath: extractDebugPath(row.errorMessage) ?? null,
      })),
      copiedDebugPaths,
    };

    const manifestPath = join(artifactDir, "summarize-failure-manifest.json");
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

    return {
      artifactDir,
      manifestPath,
      debugPaths: Array.from(rawDebugPaths),
    };
  } finally {
    database.close();
  }
}
