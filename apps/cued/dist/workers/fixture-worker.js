import { buildFixtureSyncBundle } from "../adapters/fixture-data.js";
function main() {
    try {
        const output = {
            ok: true,
            bundle: buildFixtureSyncBundle(),
        };
        process.stdout.write(JSON.stringify(output));
    }
    catch (error) {
        const output = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
        process.stdout.write(JSON.stringify(output));
        process.exitCode = 1;
    }
}
main();
//# sourceMappingURL=fixture-worker.js.map