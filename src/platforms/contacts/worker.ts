import type { AdapterWorkerOutput } from "../core/sync.js";
import { buildContactsSyncBundle } from "./sync.js";

function main(): void {
  try {
    const output: AdapterWorkerOutput = {
      ok: true,
      bundle: buildContactsSyncBundle(),
    };
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

main();
