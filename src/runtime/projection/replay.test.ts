import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import {
  projectPendingRawEvents,
  projectRealtimeRange,
  rebuildProjectedState,
} from "./projector.js";
import { replayFixtures } from "./replay-fixtures.js";
import { readCanonicalProjectionSnapshot } from "./replay-snapshot.js";

describe("projection replay", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-projection-replay-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  function seedFixture(db: CuedDatabase, fixtureName: string): void {
    const fixture = replayFixtures.find((entry) => entry.name === fixtureName);
    if (!fixture) {
      throw new Error(`Missing replay fixture: ${fixtureName}`);
    }

    db.insertRawEvents(fixture.events);
  }

  function projectDeferredFully(db: CuedDatabase): void {
    while (db.getProjectionBacklog().pending_raw_events > 0) {
      projectPendingRawEvents(db, { limit: 1 });
    }
  }

  for (const fixture of replayFixtures) {
    it(`replays ${fixture.name} consistently across rebuild and paginated catchup`, () => {
      const rebuildDb = createDb();
      const paginatedDb = createDb();
      const insertedRangeDb = createDb();
      try {
        seedFixture(rebuildDb, fixture.name);
        rebuildProjectedState(rebuildDb);
        const rebuildSnapshot = readCanonicalProjectionSnapshot(rebuildDb);

        seedFixture(paginatedDb, fixture.name);
        projectDeferredFully(paginatedDb);
        const paginatedSnapshot = readCanonicalProjectionSnapshot(paginatedDb);

        const insertResult = insertedRangeDb.insertRawEvents(fixture.events);
        if (insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null) {
          projectRealtimeRange(insertedRangeDb, {
            startRowId: insertResult.firstInsertedRowId,
            endRowId: insertResult.lastInsertedRowId,
            batchSize: 1,
          });
        }
        const insertedRangeSnapshot = readCanonicalProjectionSnapshot(insertedRangeDb);

        expect(paginatedSnapshot).toEqual(rebuildSnapshot);
        expect(insertedRangeSnapshot).toEqual(rebuildSnapshot);
        fixture.assert?.(rebuildSnapshot);
      } finally {
        rebuildDb.close();
        paginatedDb.close();
        insertedRangeDb.close();
      }
    });
  }
});
