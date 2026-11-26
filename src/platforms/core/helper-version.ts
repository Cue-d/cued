import { execFile, execFileSync } from "node:child_process";
import { statSync } from "node:fs";

/**
 * What `<helper> version` printed, remembered per build of the helper.
 *
 * Status and capability checks ask each bundled helper for its version, which means spawning
 * it: tens of milliseconds, synchronously, on a path the daemon runs at startup, on every
 * status refresh and for every integration row. The answer cannot change until the binary
 * does, so it is looked up once per binary (identified by path, size and timestamps).
 * Failures are not remembered: a helper that could not run may run next time.
 */
const versionOutputs = new Map<string, string>();

function helperBuildIdentity(helperPath: string): string | null {
  try {
    const stat = statSync(helperPath);
    return `${helperPath}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

/** The helper's `version` output, or null if it cannot be run. Spawns at most once per build. */
export function readHelperVersionOutput(helperPath: string): string | null {
  const identity = helperBuildIdentity(helperPath);
  const cached = identity ? versionOutputs.get(identity) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  try {
    const stdout = execFileSync(helperPath, ["version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (identity) {
      versionOutputs.set(identity, stdout);
    }
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Looks the version up without blocking, so a long-lived process can have the answer ready
 * before anything asks for it synchronously.
 */
export function warmHelperVersionOutput(helperPath: string | null): Promise<void> {
  const identity = helperPath ? helperBuildIdentity(helperPath) : null;
  if (!helperPath || !identity || versionOutputs.has(identity)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(helperPath, ["version"], { encoding: "utf8" }, (error, stdout) => {
      if (!error) {
        versionOutputs.set(identity, stdout);
      }
      resolve();
    });
  });
}
