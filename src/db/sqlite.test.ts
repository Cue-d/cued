import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

describe("sqlite key loading", async () => {
  const { openSqliteDatabase } = await import("./sqlite.js");
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    execFileSyncMock.mockReset();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("does not create a new key when an encrypted DB exists but no key is available", () => {
    vi.stubEnv("VITEST_WORKER_ID", "");
    vi.stubEnv("CUED_DB_KEY", "test-encryption-key");

    const dir = mkdtempSync(join(tmpdir(), "cued-sqlite-key-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "local.db");
    const sqlite = openSqliteDatabase(dbPath);
    sqlite.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY)").run();
    sqlite.close();

    vi.stubEnv("CUED_DB_KEY", "");
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes("find-generic-password")) {
        throw new Error("missing key");
      }
      if (args.includes("add-generic-password")) {
        throw new Error("unexpected key creation");
      }
      throw new Error(`unexpected security command: ${args.join(" ")}`);
    });

    expect(() => openSqliteDatabase(dbPath)).toThrow(
      "Failed to load the Cued database encryption key for an existing encrypted DB",
    );
    expect(
      execFileSyncMock.mock.calls.some(
        ([, args]) => Array.isArray(args) && args.includes("add-generic-password"),
      ),
    ).toBe(false);
  });

  it("rekeys existing plaintext WAL databases", () => {
    vi.stubEnv("VITEST_WORKER_ID", "");
    vi.stubEnv("CUED_DB_KEY", "test-encryption-key");

    const dir = mkdtempSync(join(tmpdir(), "cued-sqlite-wal-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "local.db");

    const plaintext = new Database(dbPath);
    plaintext.pragma("journal_mode=WAL");
    plaintext.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)").run();
    plaintext.prepare("INSERT INTO t (value) VALUES (?)").run("before");
    plaintext.close();

    const encrypted = openSqliteDatabase(dbPath);
    expect(encrypted.prepare("SELECT value FROM t").get()).toEqual({ value: "before" });
    encrypted.close();

    const unreadable = new Database(dbPath);
    expect(() => unreadable.prepare("SELECT value FROM t").get()).toThrow();
    unreadable.close();
  });
});
