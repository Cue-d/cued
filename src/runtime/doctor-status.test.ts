import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

import { CuedDatabase } from "../db/database.js";
import { buildPermissionStatus } from "./doctor.js";

const itDarwin = process.platform === "darwin" ? it : it.skip;

describe("permission status", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.CUED_CONTACTS_NATIVE_BINARY;
    delete process.env.CUED_IMESSAGE_NATIVE_BINARY;
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-doctor-status-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  itDarwin("omits removed permission checks", async () => {
    const db = createDb();
    process.env.CUED_CONTACTS_NATIVE_BINARY = "/tmp/cued-native-helper";
    process.env.CUED_IMESSAGE_NATIVE_BINARY = "/tmp/cued-native-helper";

    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === "/tmp/cued-native-helper" && args?.[0] === "contacts") {
        return '{"status":"authorized"}';
      }
      if (command === "/tmp/cued-native-helper" && args?.[0] === "imessage") {
        return "";
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const status = await buildPermissionStatus();

    expect(status.permissions.map((permission) => permission.key)).toEqual([
      "contacts",
      "full_disk_access",
    ]);
    expect(execFileSyncMock.mock.calls.some(([command]) => command === "osascript")).toBe(false);

    db.close();
  });
});
