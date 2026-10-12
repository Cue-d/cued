import { createHash } from "node:crypto";
import type { AdapterWorkerOutput, SyncBundle } from "./sync.js";

export function providerStableHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export async function runAdapterWorker(
  build: () => SyncBundle | Promise<SyncBundle>,
  isAuthInvalidationError?: (error: unknown) => boolean,
): Promise<void> {
  try {
    const bundle = await build();
    writeAdapterWorkerOutput({ ok: true, bundle });
  } catch (error) {
    writeAdapterWorkerFailure(error, isAuthInvalidationError);
  }
}

export function runAdapterWorkerSync(build: () => SyncBundle): void {
  try {
    const bundle = build();
    writeAdapterWorkerOutput({ ok: true, bundle });
  } catch (error) {
    writeAdapterWorkerFailure(error);
  }
}

function writeAdapterWorkerOutput(output: AdapterWorkerOutput): void {
  process.stdout.write(JSON.stringify(output));
}

function writeAdapterWorkerFailure(
  error: unknown,
  isAuthInvalidationError?: (error: unknown) => boolean,
): void {
  writeAdapterWorkerOutput({
    ok: false,
    ...(isAuthInvalidationError?.(error) ? { errorCode: "auth_invalid" as const } : {}),
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
