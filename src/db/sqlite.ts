import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";
import { ensureCuedDirs } from "../core/config.js";

const DB_KEYCHAIN_SERVICE = "dev.cued.db";
const DB_KEYCHAIN_ACCOUNT = "local-db-key";

type SQLiteOpenOptions = {
  readonly?: boolean;
};

function quotePragmaValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function applyKey(sqlite: Database.Database, key: string): void {
  sqlite.pragma(`key=${quotePragmaValue(key)}`);
}

function verifyReadable(sqlite: Database.Database): void {
  sqlite.prepare("SELECT count(*) AS count FROM sqlite_master").get();
}

function tryVerifyReadable(sqlite: Database.Database): boolean {
  try {
    verifyReadable(sqlite);
    return true;
  } catch {
    return false;
  }
}

function hardenDbPaths(dbPath: string): void {
  const candidatePaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  for (const path of candidatePaths) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort only.
    }
  }
}

export function loadOrCreateDatabaseKey(): string {
  const existingKey = loadExistingDatabaseKey();
  if (existingKey) {
    return existingKey;
  }

  return createAndStoreDatabaseKey();
}

export function loadExistingDatabaseKey(): string | null {
  const configuredKey = process.env.CUED_DB_KEY?.trim();
  if (configuredKey) {
    return configuredKey;
  }
  const vitestWorkerKey = process.env.VITEST_WORKER_ID?.trim();
  if (vitestWorkerKey) {
    return `vitest-worker-${vitestWorkerKey}`;
  }

  try {
    const key = execFileSync(
      "security",
      ["find-generic-password", "-s", DB_KEYCHAIN_SERVICE, "-a", DB_KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (key.length > 0) {
      return key;
    }
  } catch {
    return null;
  }
  return null;
}

function createAndStoreDatabaseKey(): string {
  const key = randomBytes(32).toString("hex");
  try {
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        DB_KEYCHAIN_SERVICE,
        "-a",
        DB_KEYCHAIN_ACCOUNT,
        "-w",
        key,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch {
    const existingKey = loadExistingDatabaseKey();
    if (existingKey && existingKey.length > 0) {
      return existingKey;
    }
    throw new Error("Failed to create or load the Cued database encryption key");
  }
  return key;
}

export function openSqliteDatabase(
  dbPath: string,
  options: SQLiteOpenOptions = {},
): Database.Database {
  ensureCuedDirs();
  const openOptions = options.readonly ? { readonly: true, fileMustExist: true } : undefined;

  if (!existsSync(dbPath)) {
    const key = loadOrCreateDatabaseKey();
    const sqlite = new Database(dbPath, openOptions);
    if (!options.readonly) {
      applyKey(sqlite, key);
      hardenDbPaths(dbPath);
    }
    return sqlite;
  }

  let sqlite = new Database(dbPath, openOptions);
  if (tryVerifyReadable(sqlite)) {
    if (options.readonly) {
      hardenDbPaths(dbPath);
      return sqlite;
    }

    const key = loadOrCreateDatabaseKey();
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    sqlite.pragma("journal_mode=DELETE");
    sqlite.pragma(`rekey=${quotePragmaValue(key)}`);
    sqlite.close();

    sqlite = new Database(dbPath, openOptions);
    applyKey(sqlite, key);
    verifyReadable(sqlite);
    hardenDbPaths(dbPath);
    return sqlite;
  }

  sqlite.close();
  const key = loadExistingDatabaseKey();
  if (!key) {
    throw new Error("Failed to load the Cued database encryption key for an existing encrypted DB");
  }
  sqlite = new Database(dbPath, openOptions);
  applyKey(sqlite, key);
  verifyReadable(sqlite);
  hardenDbPaths(dbPath);
  return sqlite;
}
