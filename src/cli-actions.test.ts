import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "./db/database.js";

describe("actions CLI", () => {
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
    const home = mkdtempSync(join(tmpdir(), "cued-cli-actions-"));
    mkdirSync(join(home, "tmp"), { recursive: true });
    tempDirs.push(home);
    runCli(home, ["status"]);
    return home;
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

  it("proposes, lists, shows, and approves actions", () => {
    const home = createHome();
    const definitions = JSON.parse(runCli(home, ["actions", "definitions"])) as Array<{
      type: string;
      version: string;
    }>;
    expect(definitions.map((definition) => `${definition.type}@${definition.version}`)).toContain(
      "contact.merge@1",
    );

    const proposed = JSON.parse(
      runCli(home, [
        "actions",
        "propose",
        "contact.merge",
        "--payload",
        '{"primaryContactId":"contact-1","secondaryContactId":"contact-2"}',
        "--title",
        "Merge duplicate contact",
        "--summary",
        "Same email address",
        "--source-skill",
        "cued",
      ]),
    ) as { id: string; status: string; approval_status: string; payload_hash: string };

    expect(proposed).toMatchObject({
      status: "proposed",
      approval_status: "pending",
      payload_hash: expect.any(String),
    });

    const listed = JSON.parse(runCli(home, ["actions", "list", "--status", "proposed"])) as Array<{
      id: string;
      action_type: string;
    }>;
    expect(listed).toEqual([
      expect.objectContaining({ id: proposed.id, action_type: "contact.merge" }),
    ]);

    const shown = JSON.parse(runCli(home, ["actions", "show", proposed.id])) as {
      action: { id: string; source_skill: string };
      effects: unknown[];
    };
    expect(shown).toEqual({
      action: expect.objectContaining({ id: proposed.id, source_skill: "cued" }),
      effects: [],
    });

    const approved = JSON.parse(
      runCli(home, ["actions", "approve", proposed.id, "--by", "soham"]),
    ) as {
      id: string;
      status: string;
      approval_status: string;
      approved_by: string;
    };
    expect(approved).toMatchObject({
      id: proposed.id,
      status: "approved",
      approval_status: "approved",
      approved_by: "soham",
    });
  });

  it("can auto-approve or deny proposed actions", () => {
    const home = createHome();
    const autoApproved = JSON.parse(
      runCli(home, [
        "actions",
        "propose",
        "contact.memory.add",
        "--payload",
        '{"contactId":"contact-1","body":"Met at demo day"}',
        "--no-approval",
      ]),
    ) as { id: string; status: string; approval_status: string };
    expect(autoApproved).toMatchObject({
      status: "approved",
      approval_status: "auto_approved",
    });

    const pending = JSON.parse(
      runCli(home, [
        "actions",
        "propose",
        "contact.memory.stale",
        "--payload",
        '{"memoryId":"memory-1"}',
      ]),
    ) as { id: string };
    const denied = JSON.parse(runCli(home, ["actions", "deny", pending.id, "--by", "soham"])) as {
      id: string;
      status: string;
      approval_status: string;
    };
    expect(denied).toMatchObject({
      id: pending.id,
      status: "denied",
      approval_status: "denied",
    });
  });

  it("validates action definitions before queueing", () => {
    const home = createHome();

    expect(() => runCli(home, ["actions", "propose", "unknown.action", "--payload", "{}"])).toThrow(
      "Unknown action definition: unknown.action@1",
    );
    expect(() =>
      runCli(home, [
        "actions",
        "propose",
        "contact.merge",
        "--payload",
        '{"primaryContactId":"contact-1"}',
      ]),
    ).toThrow("Missing required payload field 'secondaryContactId'.");
  });

  it("executes approved actions", () => {
    const home = createHome();
    insertContact(home, "contact-1", "Ava Chen");

    const action = JSON.parse(
      runCli(home, [
        "actions",
        "propose",
        "contact.memory.add",
        "--payload",
        '{"contactId":"contact-1","body":"Met at demo day","sourceKind":"local_messages"}',
      ]),
    ) as { id: string };
    runCli(home, ["actions", "approve", action.id, "--by", "soham"]);
    const executed = JSON.parse(
      runCli(home, ["actions", "execute", action.id, "--by", "runner"]),
    ) as {
      action: { status: string; execution_status: string; executed_by: string };
      effects: Array<{ effect_type: string; target_table: string; target_id: string }>;
    };

    expect(executed.action).toMatchObject({
      status: "executed",
      execution_status: "succeeded",
      executed_by: "runner",
    });
    expect(executed.effects).toEqual([
      expect.objectContaining({
        effect_type: "contact_memory.added",
        target_table: "contact_memories",
        target_id: expect.any(String),
      }),
    ]);
  });

  it("runs approved pending actions in a batch", () => {
    const home = createHome();
    insertContact(home, "contact-1", "Ava Chen");

    const action = JSON.parse(
      runCli(home, [
        "actions",
        "propose",
        "contact.memory.add",
        "--payload",
        '{"contactId":"contact-1","body":"Batch memory"}',
        "--no-approval",
      ]),
    ) as { id: string };
    const result = JSON.parse(
      runCli(home, ["actions", "run-approved", "--limit", "5", "--by", "batch-runner"]),
    ) as {
      attempted: number;
      succeeded: number;
      failed: number;
      results: Array<{ actionId: string; ok: boolean }>;
    };

    expect(result).toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      results: [expect.objectContaining({ actionId: action.id, ok: true })],
    });
  });
});
