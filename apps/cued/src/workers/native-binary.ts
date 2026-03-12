import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function resolveRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
}

export function getMacOSNativeBinaryCandidates(repoRoot = resolveRepoRoot()): string[] {
  const packageRoot = join(repoRoot, "native", "macos", "CuedNative");
  return [
    join(packageRoot, ".build", "release", "CuedNative"),
    join(packageRoot, ".build", "debug", "CuedNative"),
    join(packageRoot, ".build", "arm64-apple-macosx", "release", "CuedNative"),
    join(packageRoot, ".build", "arm64-apple-macosx", "debug", "CuedNative"),
    join(packageRoot, ".build", "x86_64-apple-macosx", "release", "CuedNative"),
    join(packageRoot, ".build", "x86_64-apple-macosx", "debug", "CuedNative"),
  ];
}

export function resolveMacOSNativeBinary(
  envVarValue: string | undefined,
  repoRoot = resolveRepoRoot(),
): string | null {
  if (envVarValue) {
    return envVarValue;
  }

  return (
    getMacOSNativeBinaryCandidates(repoRoot).find((candidate) => existsSync(candidate)) ?? null
  );
}
