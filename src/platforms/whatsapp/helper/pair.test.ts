import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import {
  getWhatsAppHelperBinaryCandidates,
  readWhatsAppHelperStatus,
  resolveWhatsAppHelperBinary,
  startWhatsAppPairSession,
} from "./pair.js";

class MockPairChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });
}

describe("whatsapp helper", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.CUED_WHATSAPP_HELPER_BINARY;
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createRepoRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-whatsapp-helper-"));
    tempDirs.push(dir);
    return dir;
  }

  it("uses the flattened repo root for implicit development candidates", () => {
    expect(getWhatsAppHelperBinaryCandidates()[0]).toBe(
      join(process.cwd(), "native", "helpers", "whatsapp-go", ".build", "cued-whatsapp-helper"),
    );
  });

  it("returns an explicit helper override first", () => {
    expect(resolveWhatsAppHelperBinary("/tmp/cued-whatsapp-helper")).toBe(
      "/tmp/cued-whatsapp-helper",
    );
  });

  it("finds the compiled helper under the repo root when available", () => {
    const repoRoot = createRepoRoot();
    const candidates = getWhatsAppHelperBinaryCandidates(repoRoot);
    mkdirSync(join(repoRoot, "native", "helpers", "whatsapp-go", ".build"), {
      recursive: true,
    });
    writeFileSync(candidates[0], "#!/bin/sh\nexit 0\n");
    chmodSync(candidates[0], 0o755);

    expect(resolveWhatsAppHelperBinary(undefined, repoRoot)).toBe(candidates[0]);
  });

  it("parses extended helper history status fields", async () => {
    const repoRoot = createRepoRoot();
    const helperPath = join(repoRoot, "cued-whatsapp-helper");
    process.env.CUED_WHATSAPP_HELPER_BINARY = helperPath;
    writeFileSync(
      helperPath,
      `#!/bin/sh
if [ "$1" = "status" ]; then
  echo '{"authenticated":true,"accountJid":"15551234567:18@s.whatsapp.net","pushName":"Theo","helperVersion":"0.1.0","lastHistorySyncAt":123,"lastHistorySyncType":"FULL","lastHistoryChunkOrder":4,"lastHistoryProgress":80,"queuedHistorySyncCount":2,"lastHistorySyncError":"download failed","lastHistoryNotificationAt":456}'
  exit 0
fi
exit 1
`,
    );
    chmodSync(helperPath, 0o755);

    await expect(readWhatsAppHelperStatus("/tmp/cued-whatsapp/default")).resolves.toEqual({
      authenticated: true,
      accountJid: "15551234567:18@s.whatsapp.net",
      pushName: "Theo",
      helperVersion: "0.1.0",
      lastHistorySyncAt: 123,
      lastHistorySyncType: "FULL",
      lastHistoryChunkOrder: 4,
      lastHistoryProgress: 80,
      queuedHistorySyncCount: 2,
      lastHistorySyncError: "download failed",
      lastHistoryNotificationAt: 456,
    });
  });

  it("resolves completion as soon as the pair helper reports connected", async () => {
    const child = new MockPairChild();
    spawnMock.mockReturnValue(child);

    const handle = startWhatsAppPairSession({
      helperPath: "/tmp/cued-whatsapp-helper",
      storeDir: "/tmp/cued-whatsapp/default",
      deviceName: "Cued",
    });

    child.stdout.write(
      `${JSON.stringify({
        event: "connected",
        data: {
          accountJid: "15551234567:18@s.whatsapp.net",
          pushName: "Theo",
          helperVersion: "0.1.0",
        },
      })}\n`,
    );

    const settled = vi.fn();
    handle.completion.then(settled).catch(() => {});
    await Promise.resolve();
    expect(settled).toHaveBeenCalledWith({
      accountJid: "15551234567:18@s.whatsapp.net",
      pushName: "Theo",
      helperVersion: "0.1.0",
    });

    await expect(handle.completion).resolves.toEqual({
      accountJid: "15551234567:18@s.whatsapp.net",
      pushName: "Theo",
      helperVersion: "0.1.0",
    });
  });
});
