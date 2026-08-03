import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import { projectPendingRawEvents } from "../../runtime/projection/projector.js";
import { buildXSyncBundle } from "./sync/bundle.js";

function writeArchive(root: string, input: { name: string; follower: boolean }): string {
  const source = join(root, "archive-source");
  rmSync(source, { recursive: true, force: true });
  mkdirSync(join(source, "data"), { recursive: true });
  writeFileSync(
    join(source, "data/account.js"),
    `window.YTD.account.part0 = [{"account":{"accountId":"10","username":"sam","accountDisplayName":"Sam"}}]`,
  );
  writeFileSync(
    join(source, "data/tweets.js"),
    `window.YTD.tweets.part0 = [{"tweet":{"entities":{"user_mentions":[{"id_str":"20","screen_name":"ava","name":"${input.name}"}]}}}]`,
  );
  writeFileSync(
    join(source, "data/direct-messages.js"),
    `window.YTD.direct_messages.part0 = [{"dmConversation":{"conversationId":"10-20","messages":[{"messageCreate":{"id":"message-1","senderId":"20","recipientId":"10","text":"Hello from the X archive","createdAt":"2026-08-03T12:00:00.000Z"}}]}}]`,
  );
  writeFileSync(
    join(source, "data/follower.js"),
    input.follower
      ? `window.YTD.follower.part0 = [{"follower":{"accountId":"20"}}]`
      : `window.YTD.follower.part0 = []`,
  );
  writeFileSync(
    join(source, "data/following.js"),
    `window.YTD.following.part0 = [{"following":{"accountId":"20"}}]`,
  );
  const archivePath = join(root, "twitter-archive.zip");
  rmSync(archivePath, { force: true });
  execFileSync("zip", ["-q", "-r", archivePath, "data"], { cwd: source });
  return archivePath;
}

async function projectArchiveCycle(db: CuedDatabase) {
  let cursor: unknown = null;
  let totalApplied = 0;
  for (let page = 0; page < 20; page += 1) {
    const bundle = await buildXSyncBundle({}, { sourceCursor: cursor });
    db.upsertSourceAccounts(bundle.sourceAccounts ?? []);
    db.insertRawEvents(bundle.rawEvents);
    totalApplied += projectPendingRawEvents(db).appliedRawEvents;
    cursor = bundle.sourceCursor;
    if (!bundle.hasMore) return { totalApplied, bundle };
  }
  throw new Error("X archive pagination did not complete");
}

describe("X archive end to end", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports an X archive through the compiled Go helper and refreshes contact state", async () => {
    const temp = mkdtempSync(join(tmpdir(), "cued-x-archive-e2e-"));
    tempDirs.push(temp);
    const archivePath = writeArchive(temp, { name: "Ava Chen", follower: true });
    const cuedPath = join(temp, "cued.sqlite");
    const helperPath = join(temp, "cued-birdclaw-helper");
    execFileSync("go", ["build", "-o", helperPath, "."], {
      cwd: resolve("native/helpers/birdclaw-go"),
      env: { ...process.env, GOWORK: "off" },
    });

    const previousHelper = process.env.CUED_X_ARCHIVE_HELPER_BINARY;
    const previousArchive = process.env.CUED_X_ARCHIVE_PATH;
    process.env.CUED_X_ARCHIVE_HELPER_BINARY = helperPath;
    process.env.CUED_X_ARCHIVE_PATH = archivePath;
    const cued = new CuedDatabase(cuedPath);
    try {
      cued.migrate();
      const first = await projectArchiveCycle(cued);
      expect(first.totalApplied).toBeGreaterThanOrEqual(4);
      const sqlite = (
        cued as unknown as {
          sqlite: {
            prepare: (sql: string) => { get: (...params: unknown[]) => Record<string, unknown> };
          };
        }
      ).sqlite;
      const readContact = () =>
        sqlite
          .prepare(`
            SELECT c.name, cs.metadata_json
            FROM contacts c JOIN contact_sources cs ON cs.contact_id = c.id
            WHERE cs.platform = 'x' AND cs.source_entity_key = 'x:user:20'
          `)
          .get() as { name: string; metadata_json: string };
      expect(readContact().name).toBe("Ava Chen");
      expect(JSON.parse(readContact().metadata_json)).toMatchObject({
        mutual: true,
        followsYou: true,
        youFollow: true,
      });
      expect(
        sqlite.prepare("SELECT content FROM messages WHERE platform = 'x'").get(),
      ).toMatchObject({ content: "Hello from the X archive" });

      writeArchive(temp, { name: "Ava Patel", follower: false });
      const second = await projectArchiveCycle(cued);
      expect(second.totalApplied).toBeGreaterThan(0);
      expect(readContact().name).toBe("Ava Patel");
      expect(JSON.parse(readContact().metadata_json)).toMatchObject({
        mutual: false,
        followsYou: false,
        youFollow: true,
      });
    } finally {
      if (previousHelper === undefined) delete process.env.CUED_X_ARCHIVE_HELPER_BINARY;
      else process.env.CUED_X_ARCHIVE_HELPER_BINARY = previousHelper;
      if (previousArchive === undefined) delete process.env.CUED_X_ARCHIVE_PATH;
      else process.env.CUED_X_ARCHIVE_PATH = previousArchive;
      cued.close();
    }
  }, 30_000);
});
