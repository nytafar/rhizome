export type EvidenceOutcome = "pass" | "skip" | "failure";

export interface EvidenceCommandRecord<T = unknown> {
  name: string;
  argv: string[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
  stdout: string;
  errorMessage?: string;
  result?: T;
}

export interface EvidenceDbSnapshot {
  generatedAt: string;
  studies: Array<{
    rhizome_id: string;
    citekey: string;
    title: string | null;
    pipeline_overall: string;
    pipeline_error: string | null;
    pipeline_steps_json: string;
  }>;
  jobs: Array<{
    id: number;
    rhizome_id: string;
    stage: string;
    status: string;
    retry_count: number;
    error_message: string | null;
    completed_at: string | null;
  }>;
  summarizeStatuses: Record<string, number>;
}

export interface EvidenceStudyArtifactCheck {
  citekey: string;
  notePath: string;
  noteExists: boolean;
  summaryPath: string;
  summaryExists: boolean;
}

export interface EvidenceLockDiagnostics {
  before: EvidenceCommandRecord;
  fixturePath: string;
  fixtureCreated: boolean;
  forcedClear: EvidenceCommandRecord;
  after: EvidenceCommandRecord;
}

export interface IntelligenceLoopEvidenceBundle {
  schemaVersion: 1;
  generatedAt: string;
  outcome: EvidenceOutcome;
  deterministicPaths: {
    dir: string;
    summaryJson: string;
    bundleJson: string;
    reportMd: string;
    debugDir: string;
  };
  preflight: {
    ok: boolean;
    reason: string;
    claudeBinary?: string;
  };
  workspace: {
    root: string;
    vaultPath: string;
    dbPath: string;
    cleanedUp: boolean;
  };
  commands: EvidenceCommandRecord[];
  statusOverview?: EvidenceCommandRecord;
  statusDetails: EvidenceCommandRecord[];
  dbSnapshot?: EvidenceDbSnapshot;
  studyArtifactChecks: EvidenceStudyArtifactCheck[];
  lockDiagnostics?: EvidenceLockDiagnostics;
  debugEvidence: {
    captured: boolean;
    sourceManifestPath?: string;
    copiedManifestPath?: string;
    copiedDebugPaths: string[];
    rawDebugPaths: string[];
  };
  failure?: {
    message: string;
    step?: string;
  };
  summary: {
    studiesCount: number;
    summarizeCompleteCount: number;
    failedCommands: string[];
    skipReason?: string;
  };
}

export interface IntelligenceLoopEvidenceSummary {
  generatedAt: string;
  outcome: EvidenceOutcome;
  reason: string;
  bundleJsonPath: string;
  reportPath: string;
  studiesCount: number;
  summarizeCompleteCount: number;
  lockDiagnosticsIncluded: boolean;
}
