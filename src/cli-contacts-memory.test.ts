import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "./db/database.js";

describe("contacts memory CLI", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createHome(): string {
    const home = mkdtempSync(join(tmpdir(), "cued-cli-memory-"));
    tempDirs.push(home);
    runCli(home, ["status"]);
    insertContact(home, "contact-1", "Ava Chen");
    return home;
  }

  function insertContact(home: string, id: string, name: string): void {
    const db = new CuedDatabase(join(home, "local.db"));
    try {
      (
        db as unknown as {
          sqlite: {
            prepare: (sql: string) => {
              run: (...params: unknown[]) => void;
            };
          };
        }
      ).sqlite
        .prepare(
          "INSERT INTO contacts (id, kind, name, photo_url, company, archived, created_at, updated_at) VALUES (?, 'person', ?, NULL, NULL, 0, 1, 1)",
        )
        .run(id, name);
    } finally {
      db.close();
    }
  }

  function runCli(home: string, args: string[]): string {
    return execFileSync("pnpm", ["--silent", "exec", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, CUED_HOME: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  it("adds, supersedes, and lists current contact memories", () => {
    const home = createHome();
    const first = JSON.parse(
      runCli(home, [
        "contacts",
        "memory",
        "add",
        "contact-1",
        "First useful memory",
        "--source",
        "local_messages",
        "--confidence",
        "80",
        "--evidence",
        '{"message_ids":["message-1"]}',
      ]),
    ) as { id: string; confidence: number; evidence_json: string };

    expect(first.confidence).toBe(80);
    expect(JSON.parse(first.evidence_json)).toEqual({ message_ids: ["message-1"] });

    const second = JSON.parse(
      runCli(home, [
        "contacts",
        "memory",
        "add",
        "contact-1",
        "--body",
        "Replacement useful memory",
        "--source",
        "local_messages",
        "--confidence",
        "95",
        "--evidence",
        '{"message_ids":["message-2"]}',
        "--supersedes",
        first.id,
      ]),
    ) as { id: string; supersedes_memory_id: string };

    expect(second.supersedes_memory_id).toBe(first.id);

    const current = JSON.parse(runCli(home, ["contacts", "memory", "list", "contact-1"])) as Array<{
      id: string;
      stale_at: number | null;
    }>;
    const withStale = JSON.parse(
      runCli(home, ["contacts", "memory", "list", "contact-1", "--include-stale"]),
    ) as Array<{ id: string; stale_at: number | null }>;

    expect(current.map((row) => row.id)).toEqual([second.id]);
    expect(withStale.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(withStale.find((row) => row.id === first.id)?.stale_at).toEqual(expect.any(Number));
  });

  it("rejects partial integer flags", () => {
    const home = createHome();

    expect(() =>
      runCli(home, [
        "contacts",
        "memory",
        "add",
        "contact-1",
        "Bad confidence",
        "--confidence",
        "90abc",
      ]),
    ).toThrow();
  });

  it("dry-runs contact merge batches from a JSON file", () => {
    const home = createHome();
    insertContact(home, "contact-2", "Ava Duplicate");
    const batchPath = join(home, "merge-batch.json");
    writeFileSync(
      batchPath,
      JSON.stringify([
        {
          primaryContactId: "contact-1",
          secondaryContactId: "contact-2",
          reason: "exact email match",
        },
      ]),
    );

    const result = JSON.parse(runCli(home, ["contacts", "merge-batch", batchPath])) as {
      applied: boolean;
      mergeCount: number;
      decisions: Array<{
        primaryContactId: string;
        secondaryContactId: string;
        canonicalContactId: string;
        reason: string;
      }>;
    };

    expect(result).toMatchObject({
      applied: false,
      mergeCount: 1,
      decisions: [
        {
          primaryContactId: "contact-1",
          secondaryContactId: "contact-2",
          canonicalContactId: "contact-1",
          reason: "exact email match",
        },
      ],
    });
  });
});
