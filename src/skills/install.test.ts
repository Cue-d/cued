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

import {
  getGlobalCuedSkillStatus,
  getLocalCuedSkillStatus,
  installGlobalCuedSkill,
  installLocalCuedSkill,
  resolveCuedSkillSourcePath,
  resolveLocalCuedSkillInstallPath,
  resolveNvmNpxPath,
} from "./install.js";

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
    mkdirSync(join(skillDir, "actions"), { recursive: true });
    writeFileSync(
      join(skillDir, "actions", "test.echo.json"),
      JSON.stringify({
        type: "test.echo",
        version: "1",
        description: "Echo test action",
        module: "actions/test-echo.cjs",
        payload: { required: {}, optional: {} },
      }),
      "utf8",
    );
    writeFileSync(
      join(skillDir, "actions", "test-echo.cjs"),
      "module.exports = { execute: () => ({ result: { ok: true }, effects: [] }) };\n",
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

  it("installs the bundled cued skill into the daemon-local skill root", () => {
    const homeDir = setTempHome();
    const appPath = createAppBundle(createTempDir("cued-skill-app-"));
    process.env.CUED_APP_PATH = appPath;

    expect(resolveLocalCuedSkillInstallPath()).toBe(join(homeDir, ".cued", "skills", "cued"));
    expect(getLocalCuedSkillStatus()).toEqual(
      expect.objectContaining({
        installed: false,
        status: "needs_action",
        installedPath: join(homeDir, ".cued", "skills", "cued"),
      }),
    );
    expect(installLocalCuedSkill()).toEqual(
      expect.objectContaining({
        ok: true,
        scope: "daemon-local",
        sourcePath: join(appPath, "Contents", "Resources", "skills", "cued"),
        installedPath: join(homeDir, ".cued", "skills", "cued"),
        actionDefinitionCount: 1,
        executorCount: 1,
      }),
    );
    expect(getLocalCuedSkillStatus()).toEqual(
      expect.objectContaining({
        installed: true,
        status: "installed",
        actionDefinitionCount: 1,
        executorCount: 1,
      }),
    );
  });

  it("installs arbitrary skill roots into the daemon-local skill root", () => {
    const homeDir = setTempHome();
    const sourceRoot = join(createTempDir("cued-custom-skill-source-"), "custom-actions");
    mkdirSync(join(sourceRoot, "actions"), { recursive: true });
    writeFileSync(join(sourceRoot, "SKILL.md"), "---\nname: custom-actions\n---\n", "utf8");
    writeFileSync(
      join(sourceRoot, "actions", "custom.note.json"),
      JSON.stringify({
        type: "custom.note",
        version: "1",
        description: "Custom note action",
        module: "actions/custom-note.cjs",
        payload: { required: {}, optional: {} },
      }),
      "utf8",
    );
    writeFileSync(
      join(sourceRoot, "actions", "custom-note.cjs"),
      "module.exports = { execute: () => ({ result: { ok: true }, effects: [] }) };\n",
      "utf8",
    );

    expect(installLocalCuedSkill(sourceRoot)).toEqual(
      expect.objectContaining({
        ok: true,
        skillName: "custom-actions",
        scope: "daemon-local",
        sourcePath: sourceRoot,
        installedPath: join(homeDir, ".cued", "skills", "custom-actions"),
        actionDefinitionCount: 1,
        executorCount: 1,
      }),
    );
    expect(getLocalCuedSkillStatus("custom-actions")).toEqual(
      expect.objectContaining({
        installed: true,
        skillName: "custom-actions",
        sourcePath: null,
        installedPath: join(homeDir, ".cued", "skills", "custom-actions"),
        actionDefinitionCount: 1,
        executorCount: 1,
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
