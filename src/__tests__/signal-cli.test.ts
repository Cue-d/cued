import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contactHandleType,
  getSignalCliBinaryCandidates,
  isSignalCliVersionSupported,
  parseSignalCliVersion,
  readSignalLinkedAccount,
  resolveSignalCliPath,
  toSignalMessage,
} from "../integrations/signal-cli.js";

describe("signal cli helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      vi.unstubAllEnvs();
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createSignalHelperBinary(path: string, version = "0.14.1"): void {
    writeFileSync(path, `#!/bin/sh\necho "signal-cli ${version}"\n`);
    chmodSync(path, 0o755);
  }

  it("parses and validates signal-cli versions", () => {
    expect(parseSignalCliVersion("signal-cli 0.13.24")).toEqual({
      major: 0,
      minor: 13,
      patch: 24,
      raw: "0.13.24",
    });
    expect(isSignalCliVersionSupported(parseSignalCliVersion("signal-cli 0.13.24"))).toBe(true);
    expect(isSignalCliVersionSupported(parseSignalCliVersion("signal-cli 0.12.9"))).toBe(false);
  });

  it("reads the linked account from Cued's managed config dir", () => {
    const dir = createTempDir("cued-signal-config-");
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "accounts.json"),
      JSON.stringify({
        accounts: [{ number: "+14155550123" }],
      }),
    );

    expect(readSignalLinkedAccount(dir)).toBe("+14155550123");
  });

  it("prefers the packaged app helper over the repo-local helper", () => {
    const repoRoot = createTempDir("cued-signal-repo-");
    const appPath = join(createTempDir("cued-signal-app-"), "Cued.app");
    const packagedHelper = join(
      appPath,
      "Contents",
      "Resources",
      "helpers",
      "signal-cli",
      "cued-signal-cli",
    );
    const repoHelper = join(
      repoRoot,
      "native",
      "helpers",
      "signal-cli",
      ".build",
      "cued-signal-cli",
      "cued-signal-cli",
    );

    mkdirSync(join(packagedHelper, ".."), { recursive: true });
    mkdirSync(join(repoHelper, ".."), { recursive: true });
    createSignalHelperBinary(packagedHelper, "0.14.1");
    createSignalHelperBinary(repoHelper, "0.13.1");

    const env = { CUED_APP_PATH: appPath } as NodeJS.ProcessEnv;
    expect(getSignalCliBinaryCandidates(env, repoRoot)).toEqual(
      expect.arrayContaining([packagedHelper, repoHelper]),
    );
    expect(resolveSignalCliPath(env, repoRoot)).toBe(packagedHelper);
  });

  it("falls back to the repo-local staged helper when no packaged app helper exists", () => {
    const repoRoot = createTempDir("cued-signal-repo-");
    const repoHelper = join(
      repoRoot,
      "native",
      "helpers",
      "signal-cli",
      ".build",
      "cued-signal-cli",
      "cued-signal-cli",
    );

    mkdirSync(join(repoHelper, ".."), { recursive: true });
    createSignalHelperBinary(repoHelper);

    expect(resolveSignalCliPath({}, repoRoot)).toBe(repoHelper);
  });

  it("returns null when no bundled helper exists and ignores legacy env overrides", () => {
    const repoRoot = createTempDir("cued-signal-repo-");
    const legacyOverride = join(createTempDir("cued-signal-legacy-"), "signal-cli");
    createSignalHelperBinary(legacyOverride);

    expect(
      resolveSignalCliPath({ CUED_SIGNAL_CLI_PATH: legacyOverride } as NodeJS.ProcessEnv, repoRoot),
    ).toBeNull();
  });

  it("normalizes received signal envelopes into message payloads", () => {
    const inbound = toSignalMessage(
      {
        envelope: {
          source: "+14155550123",
          sourceName: "Ben",
          timestamp: 1_710_000_000_000,
          serverGuid: "msg-1",
          dataMessage: {
            message: "Hello from Signal",
          },
        },
      },
      "+14155550000",
      0,
    );

    expect(inbound).toEqual(
      expect.objectContaining({
        messageId: "msg-1",
        threadId: "dm:+14155550123",
        threadType: "dm",
        senderHandle: "+14155550123",
        senderName: "Ben",
        isFromMe: false,
        text: "Hello from Signal",
      }),
    );

    const outbound = toSignalMessage(
      {
        envelope: {
          syncMessage: {
            sentMessage: {
              destinationNumber: "+14155550123",
              timestamp: 1_710_000_000_100,
              message: "Sent from me",
            },
          },
        },
      },
      "+14155550000",
      1,
    );

    expect(outbound).toEqual(
      expect.objectContaining({
        threadId: "dm:+14155550123",
        isFromMe: true,
        peerHandle: "+14155550123",
        text: "Sent from me",
      }),
    );
    expect(contactHandleType("+14155550123")).toBe("phone");
    expect(contactHandleType("uuid-123")).toBe("signal_id");
  });
});
