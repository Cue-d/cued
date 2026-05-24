import { readAdapterInvocation } from "../core/invocation.js";
import type { AdapterWorkerOutput } from "../core/sync.js";
import { buildIMessageSyncBundle, DEFAULT_IMESSAGE_BATCH_LIMIT } from "./sync.js";

async function main(): Promise<void> {
  try {
    const invocation = await readAdapterInvocation();
    const bundle = buildIMessageSyncBundle({
      lastRowId: invocation.imessageLastRowId ?? 0,
      sourceCursor: invocation.sourceCursor,
      limit: DEFAULT_IMESSAGE_BATCH_LIMIT,
    });
    const output: AdapterWorkerOutput = { ok: true, bundle };
    process.stdout.write(JSON.stringify(output));
  } catch (error) {
    const output: AdapterWorkerOutput = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    process.stdout.write(JSON.stringify(output));
    process.exitCode = 1;
  }
}

void main();
