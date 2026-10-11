import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import { projectRealtimeRange } from "./projector.js";

it("skips all overview scans for realtime batches and empty ranges while retaining default statistics", () => {
  const dir = mkdtempSync(join(tmpdir(), "cued-realtime-overview-"));
  const db = new CuedDatabase(join(dir, "local.db"));
  try {
    db.migrate();
    for (let i = 1; i <= 3; i++) {
      db.insertRawEvent({
        id: `contact-${i}`,
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: i,
        dedupeKey: `contact-${i}`,
        sourceVersion: "contacts-v1",
        payload: {
          sourceEntityKey: `contact-${i}`,
          fields: { display_name: `Person ${i}` },
          handles: [],
        },
      });
    }
    const overview = vi.spyOn(db, "getProjectionOverview").mockImplementation(() => {
      throw new Error("realtime hot path must not scan overview tables");
    });
    const result = projectRealtimeRange(db, {
      startRowId: 1,
      endRowId: 3,
      batchSize: 1,
      includeOverview: false,
    });
    expect(result).toMatchObject({ appliedRawEvents: 3, projectionWatermark: 3, completed: true });
    projectRealtimeRange(db, { startRowId: 4, endRowId: 3, includeOverview: false });
    projectRealtimeRange(db, { startRowId: 4, endRowId: 5, includeOverview: false });
    expect(overview).not.toHaveBeenCalled();
    overview.mockRestore();
    expect(projectRealtimeRange(db, { startRowId: 4, endRowId: 3 })).toMatchObject({
      contacts: 3,
      rawEvents: 3,
    });
    expect(projectRealtimeRange(db, { startRowId: 1, endRowId: 3, batchSize: 1 })).toMatchObject({
      contacts: 3,
      rawEvents: 3,
      appliedRawEvents: 3,
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
