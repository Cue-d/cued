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

import { buildPermissionStatus } from "./doctor.js";

const itDarwin = process.platform === "darwin" ? it : it.skip;

describe("permission status modes", () => {
  afterEach(() => {
    delete process.env.CUED_CONTACTS_NATIVE_BINARY;
    delete process.env.CUED_IMESSAGE_NATIVE_BINARY;
    vi.clearAllMocks();
  });

  itDarwin("omits automation verification from passive permission status", async () => {
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
  });
});
