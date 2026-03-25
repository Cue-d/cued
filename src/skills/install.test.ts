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

import { installGlobalCuedSkill, resolveCuedSkillSourcePath } from "./install.js";

describe("cued skill installer", () => {
  const tempDirs: string[] = [];
  const originalHome = process.env.HOME;
  const originalAppPath = process.env.CUED_APP_PATH;

  afterEach(() => {
    process.env.HOME = originalHome;
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
    process.env.HOME = homeDir;
    return homeDir;
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
  <string>dev.cued.app</string>
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
    process.env.CUED_APP_PATH = appPath;

    execFileSyncMock.mockImplementation(
      (command: string, args?: string[], options?: { env?: Record<string, string> }) => {
        if (command === "/bin/zsh") {
          expect(args).toEqual(["-lc", "command -v npx"]);
          return "/opt/homebrew/bin/npx\n";
        }

        if (command === "/opt/homebrew/bin/npx") {
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
          expect(options?.env?.PATH?.startsWith("/opt/homebrew/bin")).toBe(true);
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
        npxPath: "/opt/homebrew/bin/npx",
        stdout: "installed",
        stderr: "",
      }),
    );
  });
});
