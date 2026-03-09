import { buildFixtureSyncBundle } from "../adapters/fixture-data.js";
import type { AdapterWorkerOutput } from "../adapters/types.js";

function main(): void {
  try {
    const output: AdapterWorkerOutput = {
      ok: true,
      bundle: buildFixtureSyncBundle(),
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
