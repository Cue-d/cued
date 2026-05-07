import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    mkdirSync(join(home, "tmp"), { recursive: true });
    tempDirs.push(home);
    runCli(home, ["status"]);
    insertContact(home, "contact-1", "Ava Chen");
    return home;
  }

  function insertContact(home: string, id: string, name: string): void {
    const originalDbKey = process.env.CUED_DB_KEY;
    process.env.CUED_DB_KEY = "test-encryption-key";
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
      if (originalDbKey === undefined) {
        delete process.env.CUED_DB_KEY;
      } else {
        process.env.CUED_DB_KEY = originalDbKey;
      }
    }
  }

  function runCli(home: string, args: string[]): string {
    return execFileSync("node", ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CUED_DB_KEY: "test-encryption-key",
        CUED_HOME: home,
        TMPDIR: join(home, "tmp"),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  it("executes contact memory actions and lists current memories", () => {
    const home = createHome();
    const firstExecuted = JSON.parse(
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
        "--execute",
      ]),
    ) as {
      result: { memory: { id: string; confidence: number; evidence_json: string } };
    };
    const first = firstExecuted.result.memory;

    expect(first.confidence).toBe(80);
    expect(JSON.parse(first.evidence_json)).toEqual({ message_ids: ["message-1"] });

    const secondExecuted = JSON.parse(
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
        "--execute",
      ]),
    ) as {
      result: { memory: { id: string; supersedes_memory_id: string } };
    };
    const second = secondExecuted.result.memory;

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

  it("rejects the removed queue flag because queueing is the default", () => {
    const home = createHome();

    expect(() =>
      runCli(home, ["contacts", "memory", "add", "contact-1", "Queued memory", "--queue"]),
    ).toThrow();
  });

  it("queues and executes contact memory actions from contact commands", () => {
    const home = createHome();
    const queued = JSON.parse(
      runCli(home, [
        "contacts",
        "memory",
        "add",
        "contact-1",
        "Queued memory",
        "--source",
        "local_messages",
      ]),
    ) as { id: string; action_type: string; status: string };
    expect(queued).toMatchObject({
      action_type: "contact.memory.add",
      status: "proposed",
    });

    const executed = JSON.parse(
      runCli(home, [
        "contacts",
        "memory",
        "add",
        "contact-1",
        "Executed memory",
        "--execute",
        "--source",
        "local_messages",
        "--by",
        "runner",
      ]),
    ) as {
      action: { action_type: string; status: string; executed_by: string };
      effects: Array<{ effect_type: string; target_table: string; target_id: string }>;
    };
    expect(executed.action).toMatchObject({
      action_type: "contact.memory.add",
      status: "executed",
      executed_by: "runner",
    });
    expect(executed.effects).toEqual([
      expect.objectContaining({
        effect_type: "contact_memory.added",
        target_table: "contact_memories",
      }),
    ]);
  });

  it("queues stale actions by default and mutates only on execute", () => {
    const home = createHome();
    const added = JSON.parse(
      runCli(home, ["contacts", "memory", "add", "contact-1", "Memory to stale", "--execute"]),
    ) as { result: { memory: { id: string } } };
    const memoryId = added.result.memory.id;

    const queued = JSON.parse(runCli(home, ["contacts", "memory", "stale", memoryId])) as {
      action_type: string;
      status: string;
    };
    expect(queued).toMatchObject({
      action_type: "contact.memory.stale",
      status: "proposed",
    });

    const beforeExecute = JSON.parse(
      runCli(home, ["contacts", "memory", "list", "contact-1"]),
    ) as Array<{ id: string; stale_at: number | null }>;
    expect(beforeExecute).toEqual([expect.objectContaining({ id: memoryId, stale_at: null })]);

    const executed = JSON.parse(
      runCli(home, ["contacts", "memory", "stale", memoryId, "--execute", "--by", "runner"]),
    ) as {
      action: { action_type: string; status: string; executed_by: string };
      effects: Array<{ effect_type: string; target_table: string; target_id: string }>;
    };
    expect(executed.action).toMatchObject({
      action_type: "contact.memory.stale",
      status: "executed",
      executed_by: "runner",
    });
    expect(executed.effects).toEqual([
      expect.objectContaining({
        effect_type: "contact_memory.marked_stale",
        target_table: "contact_memories",
        target_id: memoryId,
      }),
    ]);
  });
});
