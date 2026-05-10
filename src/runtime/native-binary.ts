import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NATIVE_HELPER_BINARY_NAME = "cued-native-helper";

function resolveRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function runtimeBundledNativeHelperBinary(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../helpers",
    NATIVE_HELPER_BINARY_NAME,
  );
}

export function getMacOSNativeBinaryCandidates(
  repoRoot = resolveRepoRoot(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const packageRoot = join(repoRoot, "native", "macos", "CuedNative");
  return [
    env.CUED_APP_PATH?.trim()
      ? join(
          env.CUED_APP_PATH.trim(),
          "Contents",
          "Resources",
          "helpers",
          NATIVE_HELPER_BINARY_NAME,
        )
      : null,
    runtimeBundledNativeHelperBinary(),
    join(packageRoot, ".build", "release", "CuedNative"),
    join(packageRoot, ".build", "debug", "CuedNative"),
    join(packageRoot, ".build", "arm64-apple-macosx", "release", "CuedNative"),
    join(packageRoot, ".build", "arm64-apple-macosx", "debug", "CuedNative"),
    join(packageRoot, ".build", "x86_64-apple-macosx", "release", "CuedNative"),
    join(packageRoot, ".build", "x86_64-apple-macosx", "debug", "CuedNative"),
  ].filter((value): value is string => Boolean(value));
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
