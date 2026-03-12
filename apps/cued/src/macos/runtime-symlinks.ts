import { lstatSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function pruneBundledRuntimeSymlinks(runtimeRoot: string): string[] {
  const normalizedRuntimeRoot = realpathSync(runtimeRoot);
  const removedPaths: string[] = [];

  function visit(dir: string): void {
    for (const entryName of readdirSync(dir)) {
      const entryPath = join(dir, entryName);
      const stat = lstatSync(entryPath);

      if (stat.isDirectory()) {
        visit(entryPath);
        continue;
      }

      if (!stat.isSymbolicLink()) {
        continue;
      }

      const linkTarget = readlinkSync(entryPath);
      const resolvedTarget = resolve(dirname(entryPath), linkTarget);

      let normalizedTarget: string | null = null;
      try {
        normalizedTarget = realpathSync(resolvedTarget);
      } catch {
        normalizedTarget = null;
      }

      const pointsInsideRuntime = normalizedTarget !== null
        && (
          normalizedTarget === normalizedRuntimeRoot
          || normalizedTarget.startsWith(`${normalizedRuntimeRoot}${sep}`)
        );

      if (pointsInsideRuntime) {
        continue;
      }

      rmSync(entryPath, { force: true, recursive: true });
      removedPaths.push(entryPath);
    }
  }

  visit(normalizedRuntimeRoot);
  return removedPaths;
}

function isInvokedDirectly(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isInvokedDirectly()) {
  const runtimeRoot = process.argv[2];
  if (!runtimeRoot) {
    console.error("Usage: node apps/cued/dist/macos/runtime-symlinks.js <runtime-root>");
    process.exit(1);
  }

  const removedPaths = pruneBundledRuntimeSymlinks(runtimeRoot);
  console.log(`Removed ${removedPaths.length} invalid runtime symlink(s)`);
}
