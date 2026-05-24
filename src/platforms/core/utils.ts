import { createHash } from "node:crypto";
import type { AdapterWorkerOutput, SyncBundle } from "./sync.js";

export function providerStableHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** Alias used by snapshot builders that already name the helper `stableId`. */
export const stableId = providerStableHash;

export async function runAdapterWorker(
  build: () => SyncBundle | Promise<SyncBundle>,
): Promise<void> {
  try {
    const bundle = await build();
    writeAdapterWorkerOutput({ ok: true, bundle });
  } catch (error) {
    writeAdapterWorkerFailure(error);
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

function writeAdapterWorkerFailure(error: unknown): void {
  writeAdapterWorkerOutput({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
