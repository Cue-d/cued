import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock, execFileAsyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
    // The non-blocking path uses promisify(execFile); give it the promise form directly.
    execFile: Object.assign(() => undefined, {
      [Symbol.for("nodejs.util.promisify.custom")]: execFileAsyncMock,
    }),
  };
});

import {
  GlobalCuedSkillMonitor,
  getGlobalCuedSkillStatus,
  installGlobalCuedSkill,
  resolveCuedSkillSourcePath,
  resolveNvmNpxPath,
} from "./install.js";

describe("cued skill installer", () => {
  const tempDirs: string[] = [];
  const originalHome = homedir();
  const originalAppPath = process.env.CUED_APP_PATH;

  afterEach(() => {
    vi.mocked(homedir).mockReturnValue(originalHome);
    process.env.CUED_APP_PATH = originalAppPath;
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
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

  function setTempHome(): string {
    const homeDir = createTempDir("cued-skill-home-");
    vi.mocked(homedir).mockReturnValue(homeDir);
    return homeDir;
  }

  function createFile(path: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }

  function createMockNpx(baseDir: string): string {
    const npxPath = join(baseDir, "bin", "npx");
    createFile(npxPath);
    return npxPath;
  }

  function createAppBundle(baseDir: string): string {
    const appPath = join(baseDir, "Cued.app");
    const macOSDir = join(appPath, "Contents", "MacOS");
    const skillDir = join(appPath, "Contents", "Resources", "skills", "cued");
    mkdirSync(macOSDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(appPath, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>so.cued.desktop</string>
  <key>CFBundleExecutable</key>
  <string>CuedDaemon</string>
  <key>CFBundleName</key>
  <string>Cued</string>
</dict>
</plist>
`,
    );
    const executablePath = join(macOSDir, "CuedDaemon");
    writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
    chmodSync(executablePath, 0o755);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: cued\ndescription: test skill\n---\n",
      "utf8",
    );
    return appPath;
  }

  it("resolves the bundled cued skill from the installed app resources", () => {
    setTempHome();
    const appPath = createAppBundle(createTempDir("cued-skill-app-"));
    process.env.CUED_APP_PATH = appPath;

    expect(resolveCuedSkillSourcePath()).toBe(
      join(appPath, "Contents", "Resources", "skills", "cued"),
    );
  });

  it("installs the bundled cued skill globally for all agents via npx skills", () => {
    setTempHome();
    const appPath = createAppBundle(createTempDir("cued-skill-app-"));
    const npxPath = createMockNpx(createTempDir("cued-skill-npx-"));
    process.env.CUED_APP_PATH = appPath;

    execFileSyncMock.mockImplementation(
      (command: string, args?: string[], options?: { env?: Record<string, string> }) => {
        if (command === "/bin/zsh") {
          expect(args).toEqual(["-lc", "command -v npx"]);
          return `${npxPath}\n`;
        }

        if (command === npxPath) {
          expect(args).toEqual([
            "--yes",
            "skills",
            "add",
            join(appPath, "Contents", "Resources", "skills", "cued"),
            "--global",
            "--agent",
            "*",
            "--yes",
          ]);
          expect(options?.env?.PATH?.startsWith(join(npxPath, ".."))).toBe(true);
          return "installed";
        }

        throw new Error(`unexpected command: ${command}`);
      },
    );

    expect(installGlobalCuedSkill()).toEqual(
      expect.objectContaining({
        ok: true,
        agent: "*",
        skillName: "cued",
        scope: "global",
        sourcePath: join(appPath, "Contents", "Resources", "skills", "cued"),
        npxPath,
        stdout: "installed",
        stderr: "",
      }),
    );
  });

  it("reports the bundled cued skill as installed when skills list includes it", () => {
    setTempHome();
    const appPath = createAppBundle(createTempDir("cued-skill-app-"));
    const npxPath = createMockNpx(createTempDir("cued-skill-npx-"));
    process.env.CUED_APP_PATH = appPath;

    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === "/bin/zsh") {
        return `${npxPath}\n`;
      }

      if (command === npxPath) {
        expect(args).toEqual(["--yes", "skills", "list", "--global"]);
        return "\u001b[36mcued\u001b[0m \u001b[38;5;102m~/.agents/skills/cued\u001b[0m\n  \u001b[38;5;102mAgents:\u001b[0m Codex, Cursor\n";
      }

      throw new Error(`unexpected command: ${command}`);
    });

    expect(getGlobalCuedSkillStatus()).toEqual(
      expect.objectContaining({
        installed: true,
        status: "installed",
        installedPath: "~/.agents/skills/cued",
      }),
    );
  });

  it("prefers the newest NVM npx version by semantic version order", () => {
    const homeDir = setTempHome();
    const appPath = createAppBundle(createTempDir("cued-skill-app-"));
    process.env.CUED_APP_PATH = appPath;

    createFile(join(homeDir, ".nvm", "versions", "node", "v20.9.0", "bin", "npx"));
    createFile(join(homeDir, ".nvm", "versions", "node", "v20.11.0", "bin", "npx"));

    expect(resolveNvmNpxPath()).toBe(
      join(homeDir, ".nvm", "versions", "node", "v20.11.0", "bin", "npx"),
    );
  });
});

describe("global skill monitor", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createHome(options: { installed: boolean }): string {
    const home = mkdtempSync(join(tmpdir(), "cued-skill-monitor-"));
    tempDirs.push(home);
    if (options.installed) {
      const skillDir = join(home, ".agents", "skills", "cued");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "# cued\n");
    }
    return home;
  }

  /**
   * Makes `npx` resolvable no matter what the host has installed: the login shell reports a
   * real (empty) executable, and running it answers through `skills`.
   */
  function stubNpx(skills: (args: string[]) => string): void {
    const binDir = mkdtempSync(join(tmpdir(), "cued-skill-monitor-npx-"));
    tempDirs.push(binDir);
    const npxPath = join(binDir, "npx");
    writeFileSync(npxPath, "#!/bin/sh\nexit 0\n");
    chmodSync(npxPath, 0o755);
    execFileAsyncMock.mockImplementation(async (file: string, args: string[]) => ({
      stdout: file === "/bin/zsh" ? `${npxPath}\n` : skills(args),
      stderr: "",
    }));
  }

  const LISTED = "Global Skills\n\ncued ~/.agents/skills/cued\n";
  const NOT_LISTED = "Global Skills\n";

  it("answers from the filesystem without launching anything when the skill is installed", () => {
    const monitor = new GlobalCuedSkillMonitor({ home: createHome({ installed: true }) });

    expect(monitor.status({ ensureInstalled: true })).toEqual(
      expect.objectContaining({ installed: true, status: "installed" }),
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it("answers immediately when the skill is missing and verifies in the background", async () => {
    stubNpx(() => LISTED);
    const changes: Array<{ installed: boolean }> = [];
    const monitor = new GlobalCuedSkillMonitor({
      home: createHome({ installed: false }),
      onChange: (status) => changes.push(status),
    });

    const immediate = monitor.status();
    expect(immediate).toEqual(expect.objectContaining({ installed: false, status: "unknown" }));
    expect(execFileSyncMock).not.toHaveBeenCalled();

    await monitor.settled();
    expect(changes).toEqual([expect.objectContaining({ installed: true })]);
    // Installed somewhere the filesystem probe does not look: the verified answer stands.
    expect(monitor.status()).toEqual(expect.objectContaining({ installed: true }));
  });

  it("installs in the background when asked to and the skill is not listed", async () => {
    let installed = false;
    stubNpx((args) => {
      if (args.includes("add")) {
        installed = true;
        return "";
      }
      return installed ? LISTED : NOT_LISTED;
    });
    const monitor = new GlobalCuedSkillMonitor({ home: createHome({ installed: false }) });

    monitor.status({ ensureInstalled: true });
    await monitor.settled();
    expect(
      execFileAsyncMock.mock.calls.some(([, args]) => (args as string[]).includes("add")),
    ).toBe(true);
    expect(monitor.status()).toEqual(expect.objectContaining({ installed: true }));
  });

  it("does not launch a second verification while the last one is recent", async () => {
    stubNpx(() => NOT_LISTED);
    const monitor = new GlobalCuedSkillMonitor({ home: createHome({ installed: false }) });

    monitor.status();
    await monitor.settled();
    const callsAfterFirst = execFileAsyncMock.mock.calls.length;
    monitor.status();
    monitor.status();
    await monitor.settled();
    expect(execFileAsyncMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
