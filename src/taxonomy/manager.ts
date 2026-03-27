import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RhizomeConfig } from "../config/schema";
import type {
  AddPendingInput,
  AtomicFs,
  AutoPromoteInput,
  AutoPromoteResult,
  RecordUsageInput,
  TaxonomyDocument,
  TaxonomyGroupName,
} from "./types";
import {
  createEmptyTaxonomyState,
  createTaxonomyDocumentSchema,
  validateConfiguredTaxonomyGroups,
} from "./schema";

interface TaxonomyManagerOptions {
  filePath: string;
  groups: readonly TaxonomyGroupName[];
  fs?: AtomicFs;
  now?: () => Date;
}

export class TaxonomyPersistenceError extends Error {
  readonly path: string;
  readonly stage: "read" | "parse" | "validate" | "write" | "rename";

  constructor(params: {
    path: string;
    stage: "read" | "parse" | "validate" | "write" | "rename";
    message: string;
  }) {
    super(`[taxonomy:${params.stage}] ${params.path}: ${params.message}`);
    this.name = "TaxonomyPersistenceError";
    this.path = params.path;
    this.stage = params.stage;
  }
}

function normalizeTaxonomyValue(value: string): string {
  return value.trim();
}

function ensurePrefixedPendingValue(value: string): string {
  if (!value.startsWith("new:")) {
    throw new Error(`Taxonomy provisional value must use new:<value> format, received: ${value}`);
  }

  const withoutPrefix = normalizeTaxonomyValue(value.slice(4));
  if (withoutPrefix.length === 0) {
    throw new Error(`Taxonomy provisional value must include text after new:, received: ${value}`);
  }

  return withoutPrefix;
}

export class TaxonomyManager {
  private readonly filePath: string;

  private readonly schema: ReturnType<typeof createTaxonomyDocumentSchema>;

  private readonly fs: AtomicFs;

  private readonly now: () => Date;

  private state: TaxonomyDocument;

  constructor(options: TaxonomyManagerOptions) {
    if (options.groups.length === 0) {
      throw new Error("TaxonomyManager requires at least one taxonomy group");
    }

    this.filePath = options.filePath;
    this.schema = createTaxonomyDocumentSchema(options.groups);
    this.fs =
      options.fs ??
      ({
        mkdir,
        readFile,
        writeFile,
        rename,
        rm,
      } satisfies AtomicFs);
    this.now = options.now ?? (() => new Date());
    this.state = createEmptyTaxonomyState(options.groups);
  }

  static fromConfig(config: RhizomeConfig): TaxonomyManager {
    const groups = validateConfiguredTaxonomyGroups(config.taxonomy.groups);
    const filePath = join(
      config.vault.path,
      config.vault.research_root,
      config.vault.system_folder,
      "taxonomy.json",
    );

    return new TaxonomyManager({
      filePath,
      groups,
    });
  }

  async load(): Promise<TaxonomyDocument> {
    let raw: string;

    try {
      raw = await this.fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return this.state;
      }

      throw new TaxonomyPersistenceError({
        path: this.filePath,
        stage: "read",
        message: String(error),
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new TaxonomyPersistenceError({
        path: this.filePath,
        stage: "parse",
        message: String(error),
      });
    }

    const validation = this.schema.safeParse(parsed);
    if (!validation.success) {
      throw new TaxonomyPersistenceError({
        path: this.filePath,
        stage: "validate",
        message: validation.error.message,
      });
    }

    this.state = validation.data;
    return this.state;
  }

  async save(nextState: TaxonomyDocument): Promise<void> {
    const validation = this.schema.safeParse(nextState);
    if (!validation.success) {
      throw new TaxonomyPersistenceError({
        path: this.filePath,
        stage: "validate",
        message: validation.error.message,
      });
    }

    const serialized = JSON.stringify(validation.data, null, 2) + "\n";
    const directory = dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp`;

    await this.fs.mkdir(directory, { recursive: true });

    try {
      await this.fs.writeFile(tempPath, serialized, "utf8");
    } catch (error) {
      throw new TaxonomyPersistenceError({
        path: this.filePath,
        stage: "write",
        message: String(error),
      });
    }

    try {
      await this.fs.rename(tempPath, this.filePath);
      this.state = validation.data;
    } catch (error) {
      throw new TaxonomyPersistenceError({
        path: this.filePath,
        stage: "rename",
        message: String(error),
      });
    } finally {
      await this.fs.rm(tempPath, { force: true });
    }
  }

  resolveAlias(
    state: TaxonomyDocument,
    group: TaxonomyGroupName,
    valueOrAlias: string,
  ): string | null {
    this.assertSupportedGroup(group);

    const normalized = normalizeTaxonomyValue(valueOrAlias);
    if (normalized.length === 0) {
      return null;
    }

    const groupState = state.groups[group];

    if (normalized in groupState.values) {
      return normalized;
    }

    for (const [canonical, entry] of Object.entries(groupState.values)) {
      if (entry.aliases.includes(normalized)) {
        return canonical;
      }
    }

    return null;
  }

  recordUsage(state: TaxonomyDocument, input: RecordUsageInput): TaxonomyDocument {
    this.assertSupportedGroup(input.group);

    const normalizedValue = normalizeTaxonomyValue(input.value);
    if (normalizedValue.length === 0) {
      throw new Error("Taxonomy usage value must be non-empty");
    }

    const usedAt = input.usedAt ?? this.now().toISOString();
    const canonical = this.resolveAlias(state, input.group, normalizedValue) ?? normalizedValue;
    const groupState = state.groups[input.group];
    const existing = groupState.values[canonical];

    if (existing) {
      groupState.values[canonical] = {
        ...existing,
        count: existing.count + 1,
        last_used_at: usedAt,
      };
    } else {
      groupState.values[canonical] = {
        count: 1,
        last_used_at: usedAt,
        aliases: [],
        created_at: usedAt,
      };
    }

    return this.validateOrThrow(state);
  }

  addPending(state: TaxonomyDocument, input: AddPendingInput): TaxonomyDocument {
    this.assertSupportedGroup(input.group);

    const normalizedPendingValue = ensurePrefixedPendingValue(normalizeTaxonomyValue(input.value));
    const seenAt = input.seenAt ?? this.now().toISOString();
    const normalizedSource = normalizeTaxonomyValue(input.source ?? "classifier");
    const source = normalizedSource.length > 0 ? normalizedSource : "classifier";

    const canonical = this.resolveAlias(state, input.group, normalizedPendingValue);
    if (canonical) {
      return this.recordUsage(state, {
        group: input.group,
        value: canonical,
        usedAt: seenAt,
      });
    }

    const groupState = state.groups[input.group];
    const existingPending = groupState.pending[normalizedPendingValue];

    if (existingPending) {
      const nextSources = existingPending.sources.includes(source)
        ? existingPending.sources
        : [...existingPending.sources, source];

      groupState.pending[normalizedPendingValue] = {
        ...existingPending,
        count: existingPending.count + 1,
        last_seen_at: seenAt,
        sources: nextSources,
      };
    } else {
      groupState.pending[normalizedPendingValue] = {
        count: 1,
        first_seen_at: seenAt,
        last_seen_at: seenAt,
        sources: [source],
      };
    }

    return this.validateOrThrow(state);
  }

  autoPromote(state: TaxonomyDocument, input: AutoPromoteInput): AutoPromoteResult {
    if (!Number.isInteger(input.threshold) || input.threshold <= 0) {
      throw new Error(`Taxonomy auto-promote threshold must be a positive integer, received: ${input.threshold}`);
    }

    const promotedAt = input.promotedAt ?? this.now().toISOString();
    const promoted: AutoPromoteResult["promoted"] = [];

    for (const group of Object.keys(state.groups) as TaxonomyGroupName[]) {
      const groupState = state.groups[group];
      const pendingEntries = Object.entries(groupState.pending);

      for (const [pendingValue, pendingEntry] of pendingEntries) {
        if (pendingEntry.count < input.threshold) {
          continue;
        }

        const canonical = this.resolveAlias(state, group, pendingValue) ?? pendingValue;
        const existingCanonical = groupState.values[canonical];
        if (existingCanonical) {
          groupState.values[canonical] = {
            ...existingCanonical,
            count: existingCanonical.count + pendingEntry.count,
            last_used_at: promotedAt,
            promoted_at: promotedAt,
            promoted_sources: [...pendingEntry.sources],
          };
        } else {
          groupState.values[canonical] = {
            count: pendingEntry.count,
            last_used_at: promotedAt,
            aliases: [],
            created_at: promotedAt,
            promoted_at: promotedAt,
            promoted_sources: [...pendingEntry.sources],
          };
        }

        delete groupState.pending[pendingValue];
        promoted.push({
          group,
          value: canonical,
          count: pendingEntry.count,
          promoted_at: promotedAt,
          sources: [...pendingEntry.sources],
        });
      }
    }

    return {
      state: this.validateOrThrow(state),
      promoted,
    };
  }

  getState(): TaxonomyDocument {
    return this.state;
  }

  private assertSupportedGroup(group: string): asserts group is TaxonomyGroupName {
    if (!(group in this.state.groups)) {
      throw new Error(`Unsupported taxonomy group: ${group}`);
    }
  }

  private validateOrThrow(state: TaxonomyDocument): TaxonomyDocument {
    const validation = this.schema.safeParse(state);
    if (!validation.success) {
      throw new TaxonomyPersistenceError({
        path: this.filePath,
        stage: "validate",
        message: validation.error.message,
      });
    }

    return validation.data;
  }
}
