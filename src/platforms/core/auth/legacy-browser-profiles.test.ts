import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authBrowserProfileDir, installedBrowserCandidates } from "./browser-resolver.js";
import {
  LEGACY_PROFILES_MARKER,
  pruneLegacyBrowserProfiles,
  scheduleLegacyBrowserProfileCleanup,
} from "./legacy-browser-profiles.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, contents: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

/** A Cued data directory with one account that has the old profile and two current ones. */
function fixture() {
  const cuedHome = mkdtempSync(join(tmpdir(), "cued-legacy-profiles-"));
  dirs.push(cuedHome);
  const browserRoot = join(cuedHome, "browser");
  const account = join(browserRoot, "slack", "T0EXAMPLE");
  // What Chrome for Testing wrote when it opened the account directory as its profile.
  write(join(account, "Local State"), "{}");
  write(join(account, "Last Version"), "143.0.7499.4");
  write(join(account, "Default", "Cookies"), "x".repeat(1000));
  write(join(account, "Default", "Local Storage", "leveldb", "000003.log"), "y".repeat(500));
  write(join(account, "GrShaderCache", "data_0"), "z".repeat(250));
  symlinkSync("host-12345", join(account, "SingletonLock"));
  // Profiles the current code uses.
  const chrome = installedBrowserCandidates("/nonexistent")[0];
  if (!chrome) throw new Error("no browser candidates");
  const current = authBrowserProfileDir(account, { ...chrome, version: null });
  write(join(current, "Local State"), "{}");
  write(join(current, "Default", "Cookies"), "keep");
  write(join(account, "managed-chromium", "Default", "Cookies"), "keep");
  return { cuedHome, browserRoot, account, current };
}

describe("pruneLegacyBrowserProfiles", () => {
  it("removes the old profile, keeps current per-browser profiles, and counts bytes", async () => {
    const { cuedHome, browserRoot, account, current } = fixture();

    const result = await pruneLegacyBrowserProfiles({
      cuedHome,
      browserRoot,
      isSignInActive: () => false,
    });

    expect(result).toMatchObject({ skipped: null, failed: [], removedEntries: 5 });
    expect(result.profiles).toHaveLength(1);
    expect(result.removedBytes).toBe(2 + "143.0.7499.4".length + 1000 + 500 + 250);
    expect(readdirSync(account).sort()).toEqual(["google-chrome", "managed-chromium"]);
    expect(readFileSync(join(current, "Default", "Cookies"), "utf8")).toBe("keep");
    expect(existsSync(join(current, "Local State"))).toBe(true);
    expect(existsSync(join(browserRoot, LEGACY_PROFILES_MARKER))).toBe(true);
  });

  it("is safe to run twice", async () => {
    const { cuedHome, browserRoot, account } = fixture();
    const options = { cuedHome, browserRoot, isSignInActive: () => false };
    await pruneLegacyBrowserProfiles(options);

    const again = await pruneLegacyBrowserProfiles(options);
    expect(again).toMatchObject({ skipped: "already_done", removedEntries: 0 });

    // Even without the marker, a second pass finds nothing left to remove.
    rmSync(join(browserRoot, LEGACY_PROFILES_MARKER));
    const withoutMarker = await pruneLegacyBrowserProfiles(options);
    expect(withoutMarker).toMatchObject({ skipped: null, removedEntries: 0, profiles: [] });
    expect(readdirSync(account).sort()).toEqual(["google-chrome", "managed-chromium"]);
  });

  it("does not follow symlinks out of the data directory", async () => {
    const { cuedHome, browserRoot, account } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "cued-legacy-outside-"));
    dirs.push(outside);
    write(join(outside, "Local State"), "{}");
    write(join(outside, "Default", "Cookies"), "outside");
    // A linked entry inside an old profile, a linked account and a linked platform directory.
    symlinkSync(outside, join(account, "Linked Cache"));
    symlinkSync(outside, join(browserRoot, "slack", "T0LINKED"));
    symlinkSync(join(outside), join(browserRoot, "linkedin"));

    const result = await pruneLegacyBrowserProfiles({
      cuedHome,
      browserRoot,
      isSignInActive: () => false,
    });

    expect(result.failed).toEqual([]);
    expect(readFileSync(join(outside, "Default", "Cookies"), "utf8")).toBe("outside");
    expect(existsSync(join(outside, "Local State"))).toBe(true);
    // The lock link is Chromium's own and is unlinked; any other link is left alone.
    expect(existsSync(join(account, "Linked Cache"))).toBe(true);
    expect(readdirSync(account)).not.toContain("SingletonLock");
  });

  it("refuses a browser directory that resolves outside the data directory", async () => {
    const cuedHome = mkdtempSync(join(tmpdir(), "cued-legacy-home-"));
    const outside = mkdtempSync(join(tmpdir(), "cued-legacy-outside-"));
    dirs.push(cuedHome, outside);
    write(join(outside, "slack", "T0EXAMPLE", "Local State"), "{}");

    const result = await pruneLegacyBrowserProfiles({
      cuedHome,
      browserRoot: outside,
      isSignInActive: () => false,
    });

    expect(result.skipped).toBe("outside_data_dir");
    expect(existsSync(join(outside, "slack", "T0EXAMPLE", "Local State"))).toBe(true);
  });

  it("skips while a sign-in is in progress and finishes on a later pass", async () => {
    const { cuedHome, browserRoot, account } = fixture();
    let signingIn = true;
    const options = { cuedHome, browserRoot, isSignInActive: () => signingIn };

    const during = await pruneLegacyBrowserProfiles(options);
    expect(during).toMatchObject({ skipped: "sign_in_active", removedEntries: 0 });
    expect(existsSync(join(account, "Local State"))).toBe(true);
    expect(existsSync(join(browserRoot, LEGACY_PROFILES_MARKER))).toBe(false);

    signingIn = false;
    const after = await pruneLegacyBrowserProfiles(options);
    expect(after.skipped).toBeNull();
    expect(existsSync(join(account, "Local State"))).toBe(false);
  });

  it("leaves an account directory without an old profile alone", async () => {
    const cuedHome = mkdtempSync(join(tmpdir(), "cued-legacy-profiles-"));
    dirs.push(cuedHome);
    const account = join(cuedHome, "browser", "discord", "default");
    write(join(account, "notes.txt"), "not a Chromium profile");
    write(join(account, "google-chrome", "Local State"), "{}");

    const result = await pruneLegacyBrowserProfiles({
      cuedHome,
      browserRoot: join(cuedHome, "browser"),
      isSignInActive: () => false,
    });

    expect(result.removedEntries).toBe(0);
    expect(readdirSync(account).sort()).toEqual(["google-chrome", "notes.txt"]);
  });
});

describe("scheduleLegacyBrowserProfileCleanup", () => {
  it("retries after a sign-in and logs what it removed", async () => {
    const { cuedHome, browserRoot, account } = fixture();
    let signingIn = true;
    const logs: { message: string; details: Record<string, unknown> }[] = [];
    const schedule = scheduleLegacyBrowserProfileCleanup({
      cuedHome,
      browserRoot,
      isSignInActive: () => signingIn,
      startDelayMs: 0,
      retryMs: 20,
      log: (message, details) => logs.push({ message, details }),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(existsSync(join(account, "Local State"))).toBe(true);
      signingIn = false;
      for (let waited = 0; waited < 2_000 && logs.length === 0; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(logs[0]).toMatchObject({
        message: "removed old sign-in browser profiles",
        details: { removedEntries: 5, failed: [] },
      });
      expect(existsSync(join(account, "Local State"))).toBe(false);
    } finally {
      schedule.stop();
    }
  });
});
