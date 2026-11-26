import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveCuedHome } from "../../../core/config.js";
import type { AuthBrowser } from "./browser-resolver.js";

const execFileAsync = promisify(execFile);
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const STALE_INSTALL_MS = 60 * 60_000;

/** Pinned in scripts/packaging/chromium-runtime.json; the same build Playwright installs. */
export interface ChromiumRuntimeManifest {
  source: string;
  playwrightRevision: string;
  browserVersion: string;
  arm64: ChromiumArchive;
  x64: ChromiumArchive;
}

interface ChromiumArchive {
  url: string;
  sha256: string;
  executable: string;
}

export interface BrowserDownloadProgress {
  stage: "downloading" | "verifying" | "extracting" | "installed";
  receivedBytes: number;
  totalBytes: number | null;
}

export function managedBrowserRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCuedHome(env), "browsers");
}

function manifestCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    env.CUED_BUNDLED_SCRIPT_ROOT && join(env.CUED_BUNDLED_SCRIPT_ROOT, "packaging"),
    env.CUED_APP_PATH && join(env.CUED_APP_PATH, "Contents", "Resources", "scripts", "packaging"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/packaging"),
  ]
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => join(dir, "chromium-runtime.json"));
}

export function readChromiumRuntimeManifest(
  env: NodeJS.ProcessEnv = process.env,
): ChromiumRuntimeManifest | null {
  const path = manifestCandidates(env).find((candidate) => existsSync(candidate));
  return path ? (JSON.parse(readFileSync(path, "utf8")) as ChromiumRuntimeManifest) : null;
}

function archiveFor(manifest: ChromiumRuntimeManifest, arch = process.arch): ChromiumArchive {
  return arch === "arm64" ? manifest.arm64 : manifest.x64;
}

/** Install directories are immutable and named after the pin, so a new pin installs beside. */
export function managedChromiumInstallDir(
  manifest: ChromiumRuntimeManifest,
  env: NodeJS.ProcessEnv = process.env,
  arch = process.arch,
): string {
  const archive = archiveFor(manifest, arch);
  const archLabel = arch === "arm64" ? "arm64" : "x64";
  return join(
    managedBrowserRoot(env),
    `chromium-${manifest.browserVersion}-${archLabel}-${archive.sha256.slice(0, 16)}`,
  );
}

function managedBrowser(manifest: ChromiumRuntimeManifest, executablePath: string): AuthBrowser {
  return {
    id: "managed-chromium",
    name: "Chromium (downloaded by Cued)",
    executablePath,
    source: "managed",
    version: manifest.browserVersion,
  };
}

/** The downloaded Chromium for the current pin, if it has been installed. Never downloads. */
export function getManagedChromium(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): AuthBrowser | null {
  const manifest = readChromiumRuntimeManifest(env);
  if (!manifest) return null;
  const executablePath = join(
    managedChromiumInstallDir(manifest, env),
    archiveFor(manifest).executable,
  );
  return exists(executablePath) ? managedBrowser(manifest, executablePath) : null;
}

async function downloadVerified(
  url: string,
  expectedSha256: string,
  destination: string,
  fetchImpl: typeof fetch,
  onProgress: (progress: BrowserDownloadProgress) => void,
): Promise<void> {
  if (!url.startsWith("https://")) {
    throw new Error("Refusing to download Chromium over a non-HTTPS URL");
  }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (response.url && !response.url.startsWith("https://")) {
    throw new Error("Chromium download was redirected to a non-HTTPS URL");
  }
  if (!response.ok || !response.body) {
    throw new Error(`Chromium download failed (HTTP ${response.status})`);
  }
  const totalHeader = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
  const hash = createHash("sha256");
  let receivedBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      receivedBytes += chunk.byteLength;
      onProgress({ stage: "downloading", receivedBytes, totalBytes });
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    meter,
    createWriteStream(destination, { mode: 0o600 }),
  );
  onProgress({ stage: "verifying", receivedBytes, totalBytes });
  const actual = hash.digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(
      `Chromium download failed checksum verification (expected ${expectedSha256}, got ${actual})`,
    );
  }
}

async function extractZip(archivePath: string, destination: string): Promise<void> {
  await execFileAsync("/usr/bin/ditto", ["-x", "-k", archivePath, destination], {
    timeout: 10 * 60_000,
  });
}

/** Removes installs for older pins and leftovers from interrupted installs. */
function pruneManagedBrowsers(root: string, keep: string): void {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const staleInstall =
      entry.startsWith(".install-") && Date.now() - statSync(path).mtimeMs > STALE_INSTALL_MS;
    const oldPin = entry.startsWith("chromium-") && path !== keep;
    if (staleInstall || oldPin) {
      void rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export interface InstallManagedChromiumOptions {
  env?: NodeJS.ProcessEnv;
  manifest?: ChromiumRuntimeManifest;
  arch?: NodeJS.Architecture;
  fetchImpl?: typeof fetch;
  extract?: (archivePath: string, destination: string) => Promise<void>;
  onProgress?: (progress: BrowserDownloadProgress) => void;
}

/**
 * Downloads the pinned Chromium into Cued's data directory and verifies its SHA-256 before
 * extracting it. Concurrent installs each stage privately and the first to finish publishes.
 */
export async function installManagedChromium(
  options: InstallManagedChromiumOptions = {},
): Promise<AuthBrowser> {
  const env = options.env ?? process.env;
  const manifest = options.manifest ?? readChromiumRuntimeManifest(env);
  if (!manifest) {
    throw new Error("Chromium download manifest is missing. Update or reinstall Cued.");
  }
  const arch = options.arch ?? process.arch;
  const archive = archiveFor(manifest, arch);
  const installDir = managedChromiumInstallDir(manifest, env, arch);
  const executablePath = join(installDir, archive.executable);
  if (existsSync(executablePath)) return managedBrowser(manifest, executablePath);

  const onProgress = options.onProgress ?? (() => {});
  const root = managedBrowserRoot(env);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(root, ".install-"));
  try {
    const archivePath = join(staging, "chromium.zip");
    await downloadVerified(
      archive.url,
      archive.sha256,
      archivePath,
      options.fetchImpl ?? fetch,
      onProgress,
    );
    onProgress({ stage: "extracting", receivedBytes: 0, totalBytes: null });
    const payload = join(staging, "payload");
    await (options.extract ?? extractZip)(archivePath, payload);
    if (!existsSync(join(payload, archive.executable))) {
      throw new Error("Chromium download did not contain the expected browser");
    }
    try {
      await rename(payload, installDir);
    } catch (error) {
      // Another sign-in finished the same install first; theirs is equally verified.
      if (!existsSync(executablePath)) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  pruneManagedBrowsers(root, installDir);
  onProgress({ stage: "installed", receivedBytes: 0, totalBytes: null });
  return managedBrowser(manifest, executablePath);
}
