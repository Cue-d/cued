import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_RUNTIME_CONFIG } from "../core/config.js";

const NATIVE_HELPER_BINARY_NAME = "cued-native-helper";
const NATIVE_APP_EXECUTABLE_NAME = "CuedDaemon";
const DEVELOPMENT_NATIVE_BINARY_NAME = "CuedNative";

function runtimeBundledNativeHelperBinary(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../helpers",
    NATIVE_HELPER_BINARY_NAME,
  );
}

function runtimeBundledAppExecutable(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../MacOS",
    NATIVE_APP_EXECUTABLE_NAME,
  );
}

function getDevelopmentNativeBinaryCandidates(repoRoot = NATIVE_RUNTIME_CONFIG.repoRoot): string[] {
  const packageRoot = join(repoRoot, "native", "macos", "CuedNative");
  return [
    join(packageRoot, ".build", "release", DEVELOPMENT_NATIVE_BINARY_NAME),
    join(packageRoot, ".build", "debug", DEVELOPMENT_NATIVE_BINARY_NAME),
    join(packageRoot, ".build", "arm64-apple-macosx", "release", DEVELOPMENT_NATIVE_BINARY_NAME),
    join(packageRoot, ".build", "arm64-apple-macosx", "debug", DEVELOPMENT_NATIVE_BINARY_NAME),
    join(packageRoot, ".build", "x86_64-apple-macosx", "release", DEVELOPMENT_NATIVE_BINARY_NAME),
    join(packageRoot, ".build", "x86_64-apple-macosx", "debug", DEVELOPMENT_NATIVE_BINARY_NAME),
  ];
}

export function getMacOSNativeBinaryCandidates(
  repoRoot = NATIVE_RUNTIME_CONFIG.repoRoot,
): string[] {
  return [runtimeBundledNativeHelperBinary(), ...getDevelopmentNativeBinaryCandidates(repoRoot)];
}

export function getMacOSAppExecutableCandidates(
  repoRoot = NATIVE_RUNTIME_CONFIG.repoRoot,
): string[] {
  return [runtimeBundledAppExecutable(), ...getDevelopmentNativeBinaryCandidates(repoRoot)];
}

export function resolveMacOSNativeBinary(repoRoot = NATIVE_RUNTIME_CONFIG.repoRoot): string | null {
  return (
    getMacOSNativeBinaryCandidates(repoRoot).find((candidate) => existsSync(candidate)) ?? null
  );
}

export function resolveMacOSAppExecutable(
  repoRoot = NATIVE_RUNTIME_CONFIG.repoRoot,
): string | null {
  return (
    getMacOSAppExecutableCandidates(repoRoot).find((candidate) => existsSync(candidate)) ?? null
  );
}
