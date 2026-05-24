import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { CUED_MANAGED_BROWSER_DIR } from "../../../core/config.js";
import type { BrowserCandidate } from "./browser-resolver.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const MANAGED_BROWSER_NAME = "Managed Chromium";
const MANAGED_BROWSER_BUNDLE_ID = "com.google.chrome.for.testing";
const METADATA_FILE = "metadata.json";
const INSTALL_LOCK_STALE_MS = 60 * 60_000;
const INSTALL_LOCK_RETRY_MS = 250;
const INSTALL_LOCK_TIMEOUT_MS = 5 * 60_000;

interface PlaywrightChromiumSpec {
  playwrightVersion: string;
  revision: string;
  browserVersion: string | null;
  packageRoot: string;
  cliPath: string;
}

interface ManagedBrowserMetadata {
  provider: "playwright";
  browser: "chromium";
  playwrightVersion: string;
  revision: string;
  browserVersion: string | null;
  platform: string;
  executablePath: string;
  installedAt: number;
}

interface InstallOptions {
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  installChromium?: (input: {
    destinationRoot: string;
    env: NodeJS.ProcessEnv;
    spec: PlaywrightChromiumSpec;
  }) => Promise<void>;
  resolveExecutablePath?: (input: {
    browserRoot: string;
    env: NodeJS.ProcessEnv;
    spec: PlaywrightChromiumSpec;
  }) => Promise<string>;
}

function managedBrowserRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CUED_MANAGED_BROWSER_DIR?.trim() || CUED_MANAGED_BROWSER_DIR;
}

function currentPlatform(): string {
  return `mac-${process.arch === "arm64" ? "arm64" : "x64"}`;
}

function readPlaywrightChromiumSpec(): PlaywrightChromiumSpec {
  const packagePath = require.resolve("playwright/package.json");
  const packageRoot = dirname(packagePath);
  const requireFromPlaywright = createRequire(packagePath);
  const playwrightVersion = (JSON.parse(readFileSync(packagePath, "utf8")) as { version: string })
    .version;
  const corePackageRoot = dirname(requireFromPlaywright.resolve("playwright-core/package.json"));
  const browsers = JSON.parse(readFileSync(join(corePackageRoot, "browsers.json"), "utf8")) as {
    browsers: Array<{ name: string; revision: string; browserVersion?: string }>;
  };
  const chromium = browsers.browsers.find((browser) => browser.name === "chromium");
  if (!chromium) {
    throw new Error("Playwright Chromium metadata was not found");
  }

  return {
    playwrightVersion,
    revision: chromium.revision,
    browserVersion: chromium.browserVersion ?? null,
    packageRoot,
    cliPath: join(packageRoot, "cli.js"),
  };
}

function versionRoot(root: string, spec: PlaywrightChromiumSpec): string {
  return join(root, `playwright-${spec.playwrightVersion}`);
}

function metadataPath(root: string, spec: PlaywrightChromiumSpec): string {
  return join(versionRoot(root, spec), METADATA_FILE);
}

function isPathInside(parent: string, child: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const childRelativePath = relative(parentPath, childPath);
  return (
    childRelativePath === "" ||
    (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function lockPath(targetRoot: string): string {
  return `${targetRoot}.lock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireInstallLock(targetRoot: string): Promise<() => void> {
  const path = lockPath(targetRoot);
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(
        join(path, "owner.json"),
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        {
          mode: 0o600,
        },
      );
      return () => {
        rmSync(path, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      try {
        const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as {
          pid?: number;
          createdAt?: number;
        };
        if (typeof owner.pid === "number" && isProcessAlive(owner.pid)) {
          if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for managed Chromium install lock");
          }
          await sleep(INSTALL_LOCK_RETRY_MS);
          continue;
        }
        if (
          typeof owner.createdAt === "number" &&
          Date.now() - owner.createdAt > INSTALL_LOCK_STALE_MS
        ) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
      } catch {
        rmSync(path, { recursive: true, force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for managed Chromium install lock");
      }
      await sleep(INSTALL_LOCK_RETRY_MS);
    }
  }
}

function readValidMetadata(
  root = managedBrowserRoot(),
  spec = readPlaywrightChromiumSpec(),
): ManagedBrowserMetadata | null {
  const path = metadataPath(root, spec);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as ManagedBrowserMetadata;
    if (
      metadata.provider !== "playwright" ||
      metadata.browser !== "chromium" ||
      metadata.playwrightVersion !== spec.playwrightVersion ||
      metadata.revision !== spec.revision ||
      metadata.platform !== currentPlatform() ||
      !isPathInside(versionRoot(root, spec), metadata.executablePath) ||
      !existsSync(metadata.executablePath)
    ) {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

async function defaultInstallChromium(input: {
  destinationRoot: string;
  env: NodeJS.ProcessEnv;
  spec: PlaywrightChromiumSpec;
}): Promise<void> {
  await execFileAsync(process.execPath, [input.spec.cliPath, "install", "chromium"], {
    env: {
      ...input.env,
      PLAYWRIGHT_BROWSERS_PATH: input.destinationRoot,
      PLAYWRIGHT_SKIP_BROWSER_GC: "1",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function defaultResolveExecutablePath(input: {
  browserRoot: string;
  env: NodeJS.ProcessEnv;
  spec: PlaywrightChromiumSpec;
}): Promise<string> {
  const script = `
const { createRequire } = require("node:module");
const requireFromPlaywright = createRequire(${JSON.stringify(join(input.spec.packageRoot, "package.json"))});
const { chromium } = requireFromPlaywright("playwright");
process.stdout.write(chromium.executablePath());
`;
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
    env: {
      ...input.env,
      PLAYWRIGHT_BROWSERS_PATH: input.browserRoot,
    },
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function promoteManagedBrowserInstall(tmpRoot: string, targetRoot: string): void {
  const backupRoot = `${targetRoot}.previous-${process.pid}-${Date.now()}`;
  let hasBackup = false;

  try {
    if (existsSync(targetRoot)) {
      renameSync(targetRoot, backupRoot);
      hasBackup = true;
    }
    renameSync(tmpRoot, targetRoot);
    if (hasBackup) {
      rmSync(backupRoot, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(targetRoot, { recursive: true, force: true });
    if (hasBackup && existsSync(backupRoot)) {
      renameSync(backupRoot, targetRoot);
    }
    throw error;
  }
}

export function getManagedChromiumStatus(env: NodeJS.ProcessEnv = process.env): {
  installed: boolean;
  root: string;
  metadata: ManagedBrowserMetadata | null;
  spec: Pick<PlaywrightChromiumSpec, "playwrightVersion" | "revision" | "browserVersion">;
} {
  const root = managedBrowserRoot(env);
  const spec = readPlaywrightChromiumSpec();
  const metadata = readValidMetadata(root, spec);
  return {
    installed: Boolean(metadata),
    root: versionRoot(root, spec),
    metadata,
    spec: {
      playwrightVersion: spec.playwrightVersion,
      revision: spec.revision,
      browserVersion: spec.browserVersion,
    },
  };
}

export function getManagedChromiumBrowser(
  env: NodeJS.ProcessEnv = process.env,
): BrowserCandidate | null {
  const metadata = readValidMetadata(managedBrowserRoot(env));
  if (!metadata) {
    return null;
  }
  return {
    name: MANAGED_BROWSER_NAME,
    executablePath: metadata.executablePath,
    appBundleIdentifier: MANAGED_BROWSER_BUNDLE_ID,
  };
}

export async function installManagedChromiumBrowser(
  options: InstallOptions = {},
): Promise<BrowserCandidate> {
  const env = options.env ?? process.env;
  const root = managedBrowserRoot(env);
  const spec = readPlaywrightChromiumSpec();
  const existing = readValidMetadata(root, spec);
  if (existing && !options.force) {
    return {
      name: MANAGED_BROWSER_NAME,
      executablePath: existing.executablePath,
      appBundleIdentifier: MANAGED_BROWSER_BUNDLE_ID,
    };
  }

  const targetRoot = versionRoot(root, spec);
  const tmpRoot = `${targetRoot}.install-${process.pid}-${Date.now()}`;
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(dirname(targetRoot), { recursive: true, mode: 0o700 });
  const releaseLock = await acquireInstallLock(targetRoot);

  try {
    const lockedExisting = readValidMetadata(root, spec);
    if (lockedExisting && !options.force) {
      return {
        name: MANAGED_BROWSER_NAME,
        executablePath: lockedExisting.executablePath,
        appBundleIdentifier: MANAGED_BROWSER_BUNDLE_ID,
      };
    }

    await (options.installChromium ?? defaultInstallChromium)({
      destinationRoot: tmpRoot,
      env,
      spec,
    });
    const tempExecutablePath = await (
      options.resolveExecutablePath ?? defaultResolveExecutablePath
    )({
      browserRoot: tmpRoot,
      env,
      spec,
    });
    if (!isPathInside(tmpRoot, tempExecutablePath) || !existsSync(tempExecutablePath)) {
      throw new Error(`Managed Chromium executable was not found at ${tempExecutablePath}`);
    }

    const executablePath = join(
      targetRoot,
      relative(resolve(tmpRoot), resolve(tempExecutablePath)),
    );

    const metadata: ManagedBrowserMetadata = {
      provider: "playwright",
      browser: "chromium",
      playwrightVersion: spec.playwrightVersion,
      revision: spec.revision,
      browserVersion: spec.browserVersion,
      platform: currentPlatform(),
      executablePath,
      installedAt: Date.now(),
    };
    writeFileSync(join(tmpRoot, METADATA_FILE), JSON.stringify(metadata, null, 2), {
      mode: 0o600,
    });
    promoteManagedBrowserInstall(tmpRoot, targetRoot);
    return {
      name: MANAGED_BROWSER_NAME,
      executablePath,
      appBundleIdentifier: MANAGED_BROWSER_BUNDLE_ID,
    };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    releaseLock();
  }
}
