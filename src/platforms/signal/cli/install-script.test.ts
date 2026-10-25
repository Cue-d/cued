import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "darwin")(
  "rejects unverified Signal downloads before extracting or publishing a runtime",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cued-signal-integrity-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const curl = join(bin, "curl");
      // Offline fake server response: never fetch or execute any real payload.
      writeFileSync(
        curl,
        '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nprintf corrupted > "$2"\n',
      );
      chmodSync(curl, 0o755);
      const installRoot = join(root, "helper");
      mkdirSync(installRoot);
      // A lock file left behind by a crashed/rebooted installer is not an active lock.
      writeFileSync(join(installRoot, ".install.lock"), "abandoned");
      const script = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../scripts/fetch-signal-cli-macos.sh",
      );
      await expect(
        promisify(execFile)("/bin/bash", [script, "--install-root", installRoot], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        }),
      ).rejects.toThrow("Checksum verification failed");
      expect(existsSync(join(installRoot, "current"))).toBe(false);
      expect(existsSync(join(installRoot, ".install.lock"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
