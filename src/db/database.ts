import { Database as BunSQLiteDatabase } from "bun:sqlite";
import { SCHEMA_MIGRATIONS, SCHEMA_VERSION, type SchemaMigration } from "./schema";

export interface DatabaseOptions {
  path?: string;
  readonly?: boolean;
  create?: boolean;
  strict?: boolean;
}

export class Database {
  private readonly options: Required<DatabaseOptions>;
  private connection: BunSQLiteDatabase | null = null;

  public constructor(options: DatabaseOptions = {}) {
    this.options = {
      path: options.path ?? ":memory:",
      readonly: options.readonly ?? false,
      create: options.create ?? true,
      strict: options.strict ?? true,
    };
  }

  public init(): void {
    if (this.connection) {
      return;
    }

    this.connection = new BunSQLiteDatabase(this.options.path, {
      readonly: this.options.readonly,
      create: this.options.create,
      strict: this.options.strict,
    });

    this.connection.exec("PRAGMA foreign_keys = ON;");
    this.connection.exec("PRAGMA journal_mode = WAL;");

    this.applyMigrations();
  }

  public close(): void {
    if (!this.connection) {
      return;
    }

    this.connection.close(false);
    this.connection = null;
  }

  public get db(): BunSQLiteDatabase {
    if (!this.connection) {
      throw new Error("Database is not initialized. Call init() first.");
    }

    return this.connection;
  }

  private applyMigrations(): void {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE TRANSACTION;");

    try {
      this.ensureConfigMetaTable();

      const currentVersion = this.getCurrentSchemaVersion();
      const pendingMigrations = SCHEMA_MIGRATIONS.filter(
        (migration) => migration.version > currentVersion,
      ).sort((a, b) => a.version - b.version);

      for (const migration of pendingMigrations) {
        this.runMigration(migration);
      }

      if (pendingMigrations.length > 0 || currentVersion === 0) {
        this.setSchemaVersion(SCHEMA_VERSION);
      }

      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  private ensureConfigMetaTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private getCurrentSchemaVersion(): number {
    const row = this.db
      .query("SELECT value FROM config_meta WHERE key = 'db_schema_version' LIMIT 1;")
      .get() as { value?: string } | null;

    if (!row?.value) {
      return 0;
    }

    const parsed = Number.parseInt(row.value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private runMigration(migration: SchemaMigration): void {
    for (const statement of migration.statements) {
      this.db.exec(statement);
    }

    this.setSchemaVersion(migration.version);
  }

  private setSchemaVersion(version: number): void {
    this.db
      .query(
        `
          INSERT INTO config_meta (key, value, updated_at)
          VALUES ('db_schema_version', ?, datetime('now'))
          ON CONFLICT(key)
          DO UPDATE SET
            value = excluded.value,
            updated_at = datetime('now');
        `,
      )
      .run(version.toString());
  }
}
