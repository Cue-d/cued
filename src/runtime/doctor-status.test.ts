import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

import { NATIVE_RUNTIME_CONFIG } from "../core/config.js";
import { CuedDatabase } from "../db/database.js";
import { buildPermissionStatus } from "./doctor.js";

const itDarwin = process.platform === "darwin" ? it : it.skip;

describe("permission status modes", () => {
  const tempDirs: string[] = [];
  const originalNativeRepoRoot = NATIVE_RUNTIME_CONFIG.repoRoot;

  afterEach(() => {
    NATIVE_RUNTIME_CONFIG.repoRoot = originalNativeRepoRoot;
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

  function installNativeBinary(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "cued-doctor-native-repo-"));
    tempDirs.push(repoRoot);
    NATIVE_RUNTIME_CONFIG.repoRoot = repoRoot;
    const binaryPath = join(
      repoRoot,
      "native",
      "macos",
      "CuedNative",
      ".build",
      "release",
      "CuedNative",
    );
    mkdirSync(join(binaryPath, ".."), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);
    return binaryPath;
  }

  itDarwin("omits removed permission checks in passive mode", async () => {
    const db = createDb();
    const nativeBinary = installNativeBinary();

    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === nativeBinary && args?.[0] === "contacts") {
        return '{"status":"authorized"}';
      }
      if (command === nativeBinary && args?.[0] === "imessage") {
        return "";
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const status = await buildPermissionStatus({
      mode: "passive",
      db,
    });

    expect(status.permissions.map((permission) => permission.key)).toEqual([
      "contacts",
      "full_disk_access",
    ]);
    expect(execFileSyncMock.mock.calls.some(([command]) => command === "osascript")).toBe(false);

    db.close();
  });
});
