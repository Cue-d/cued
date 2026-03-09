import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContactsSyncBundle,
  getNativeContactsBinaryCandidates,
  resolveContactsLoader,
} from "../workers/contacts-worker-lib.js";

describe("contacts worker loader resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createRepoRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-native-"));
    tempDirs.push(dir);
    return dir;
  }

  it("prefers fixture input when configured", () => {
    const repoRoot = createRepoRoot();
    expect(
      resolveContactsLoader(
        {
          CUED_CONTACTS_JSON_PATH: "/tmp/contacts.json",
          CUED_CONTACTS_NATIVE_BINARY: "/tmp/native-cued",
        },
        repoRoot,
      ),
    ).toEqual({
      kind: "fixture",
      path: "/tmp/contacts.json",
    });
  });

  it("finds the compiled native exporter when present", () => {
    const repoRoot = createRepoRoot();
    const candidates = getNativeContactsBinaryCandidates(repoRoot);
    mkdirSync(join(repoRoot, "native", "macos", "CuedNative", ".build", "release"), {
      recursive: true,
    });
    writeFileSync(candidates[0], "#!/bin/sh\nexit 0\n");
    chmodSync(candidates[0], 0o755);

    expect(resolveContactsLoader({}, repoRoot)).toEqual({
      kind: "native",
      path: candidates[0],
    });
  });

  it("falls back to JXA when no fixture or native binary exists", () => {
    const repoRoot = createRepoRoot();
    expect(resolveContactsLoader({}, repoRoot)).toEqual({ kind: "jxa" });
  });

  it("accepts the cached contacts wrapper shape", () => {
    const repoRoot = createRepoRoot();
    const fixturePath = join(repoRoot, "contacts-cache.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        contacts: [
          {
            displayName: "Ava Chen",
            company: "Cued",
            phoneNumbers: ["+1 (415) 555-0101"],
            emails: ["ava@cued.com"],
          },
        ],
      }),
    );

    const originalPath = process.env.CUED_CONTACTS_JSON_PATH;
    try {
      process.env.CUED_CONTACTS_JSON_PATH = fixturePath;
      const bundle = buildContactsSyncBundle();
      expect(bundle.rawEvents).toHaveLength(1);
      expect(bundle.rawEvents[0]?.payload).toEqual(
        expect.objectContaining({
          fields: expect.objectContaining({
            display_name: "Ava Chen",
            company: "Cued",
          }),
        }),
      );
    } finally {
      if (originalPath === undefined) {
        delete process.env.CUED_CONTACTS_JSON_PATH;
      } else {
        process.env.CUED_CONTACTS_JSON_PATH = originalPath;
      }
    }
  });
});
