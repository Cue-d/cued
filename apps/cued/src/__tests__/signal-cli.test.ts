import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contactHandleType,
  isSignalCliVersionSupported,
  parseSignalCliVersion,
  readSignalLinkedAccount,
  toSignalMessage,
} from "../integrations/signal-cli.js";

describe("signal cli helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      vi.unstubAllEnvs();
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
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
    writeFileSync(join(dataDir, "accounts.json"), JSON.stringify({
      accounts: [{ number: "+14155550123" }],
    }));

    expect(readSignalLinkedAccount(dir)).toBe("+14155550123");
  });

  it("normalizes received signal envelopes into message payloads", () => {
    const inbound = toSignalMessage({
      envelope: {
        source: "+14155550123",
        sourceName: "Ben",
        timestamp: 1_710_000_000_000,
        serverGuid: "msg-1",
        dataMessage: {
          message: "Hello from Signal",
        },
      },
    }, "+14155550000", 0);

    expect(inbound).toEqual(expect.objectContaining({
      messageId: "msg-1",
      threadId: "dm:+14155550123",
      threadType: "dm",
      senderHandle: "+14155550123",
      senderName: "Ben",
      isFromMe: false,
      text: "Hello from Signal",
    }));

    const outbound = toSignalMessage({
      envelope: {
        syncMessage: {
          sentMessage: {
            destinationNumber: "+14155550123",
            timestamp: 1_710_000_000_100,
            message: "Sent from me",
          },
        },
      },
    }, "+14155550000", 1);

    expect(outbound).toEqual(expect.objectContaining({
      threadId: "dm:+14155550123",
      isFromMe: true,
      peerHandle: "+14155550123",
      text: "Sent from me",
    }));
    expect(contactHandleType("+14155550123")).toBe("phone");
    expect(contactHandleType("uuid-123")).toBe("signal_id");
  });
});
