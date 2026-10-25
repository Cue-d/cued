import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), resolve: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("./client.js", () => ({ resolveSignalCliPath: mocks.resolve }));

import { ensureSignalCliAvailable } from "./install.js";

describe.skipIf(process.platform !== "darwin")("optional Signal installer", () => {
  const dirs: string[] = [];
  function environment() {
    const dir = mkdtempSync(join(tmpdir(), "cued-signal-install-test-"));
    dirs.push(dir);
    return { ...process.env, CUED_HOME: dir };
  }
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("does not run an installer when a bundled or managed helper exists", async () => {
    mocks.resolve.mockReturnValue("/existing/helper");
    expect(await ensureSignalCliAvailable(environment())).toBe("/existing/helper");
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("coalesces concurrent installation and resolves the published helper", async () => {
    const env = environment();
    mocks.resolve.mockReturnValue(null);
    mocks.exec.mockImplementation((_file, _args, _options, callback) => {
      setTimeout(() => {
        mocks.resolve.mockReturnValue("/installed/helper");
        callback(null, "", "");
      }, 1);
    });
    expect(
      await Promise.all([ensureSignalCliAvailable(env), ensureSignalCliAvailable(env)]),
    ).toEqual(["/installed/helper", "/installed/helper"]);
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.exec.mock.calls[0]?.[1]).toEqual([
      expect.stringMatching(/fetch-signal-cli-macos.sh$/),
      "--install-root",
      join(env.CUED_HOME, "helpers", "signal-cli"),
    ]);
  });

  it("upgrades an older managed runtime instead of retaining its published path", async () => {
    const env = environment();
    const root = join(env.CUED_HOME, "helpers", "signal-cli");
    mkdirSync(root, { recursive: true });
    mocks.resolve.mockReturnValue(join(realpathSync(root), "older-version", "cued-signal-cli"));
    mocks.exec.mockImplementation((_file, _args, _options, callback) => {
      mocks.resolve.mockReturnValue("/new/runtime/cued-signal-cli");
      callback(null, "", "");
    });
    expect(await ensureSignalCliAvailable(env)).toBe("/new/runtime/cued-signal-cli");
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });

  it("backs off failed downloads and preserves an actionable error", async () => {
    const env = environment();
    mocks.resolve.mockReturnValue(null);
    mocks.exec.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error("offline"));
    });
    await expect(ensureSignalCliAvailable(env)).rejects.toThrow(/internet connection.*offline/);
    await expect(ensureSignalCliAvailable(env)).rejects.toThrow(/retry connecting Signal/);
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });
});
