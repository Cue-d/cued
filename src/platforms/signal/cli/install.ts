import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveCuedHome } from "../../../core/config.js";
import { resolveSignalCliPath } from "./client.js";

const execFileAsync = promisify(execFile);
const attempts = new Map<string, { promise: Promise<string>; retryAfter: number }>();
const RETRY_DELAY_MS = 5 * 60_000;

/** Explicit auth and existing linked accounts may provision; diagnostics never download. */
export async function ensureSignalCliAvailable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const existing = resolveSignalCliPath(env);
  const configuredRoot = join(resolveCuedHome(env), "helpers", "signal-cli");
  const root = existsSync(configuredRoot) ? realpathSync(configuredRoot) : resolve(configuredRoot);
  // Preserve packaged/developer helpers. Managed helpers follow the shipped pins
  // so updating Cued also updates the optional runtime without resetting accounts.
  if (existing && !existing.startsWith(`${root}/`)) return existing;
  const script = resolveInstallerScript(env);
  const manifest = JSON.parse(
    readFileSync(join(dirname(script), "packaging", "signal-runtime.json"), "utf8"),
  ) as {
    signalVersion: string;
    signalArchiveSha256: string;
    jreVersionLabel: string;
    arm64: { jreArchiveSha256: string };
    x64: { jreArchiveSha256: string };
  };
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const revision = `signal-${manifest.signalVersion}-jre-${manifest.jreVersionLabel}-${arch}-${manifest.signalArchiveSha256.slice(0, 16)}-${manifest[arch].jreArchiveSha256.slice(0, 16)}`;
  if (existing === join(root, revision, "cued-signal-cli")) return existing;
  const previous = attempts.get(root);
  if (previous && Date.now() < previous.retryAfter) return previous.promise;

  const attempt = { promise: Promise.resolve(""), retryAfter: Number.POSITIVE_INFINITY };
  attempt.promise = installSignalCli(root, script, env).finally(() => {
    // Coalesce callers while downloading and back off failures on periodic refresh.
    attempt.retryAfter = Date.now() + RETRY_DELAY_MS;
  });
  attempts.set(root, attempt);
  return attempt.promise;
}

function resolveInstallerScript(env: NodeJS.ProcessEnv): string {
  const script = [
    env.CUED_BUNDLED_SCRIPT_ROOT && join(env.CUED_BUNDLED_SCRIPT_ROOT, "fetch-signal-cli-macos.sh"),
    env.CUED_APP_PATH &&
      join(env.CUED_APP_PATH, "Contents", "Resources", "scripts", "fetch-signal-cli-macos.sh"),
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../scripts/fetch-signal-cli-macos.sh",
    ),
  ].find((path): path is string => Boolean(path && existsSync(path)));
  if (!script) {
    throw new Error(
      "Signal installer is missing. Update or reinstall Cued, then reconnect Signal.",
    );
  }
  return script;
}

async function installSignalCli(
  root: string,
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("Automatic Signal helper installation currently requires macOS.");
  }
  try {
    // This is our local, shipped installer, not a remotely downloaded script.
    // It verifies pinned SHA-256 digests before extracting either upstream archive.
    await execFileAsync("/bin/bash", [script, "--install-root", root], {
      env,
      timeout: 15 * 60_000,
      maxBuffer: 1024 * 1024,
    });
    const installed = resolveSignalCliPath(env);
    if (!installed) throw new Error("Installer completed without a usable helper");
    return installed;
  } catch (error) {
    throw new Error(
      `Could not install the Signal helper. Check your internet connection and available disk space, then retry connecting Signal in five minutes. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
