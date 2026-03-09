import { buildIMessageSyncBundle } from "../workers/imessage-worker-lib.js";
async function main() {
    try {
        const bundle = buildIMessageSyncBundle({
            path: process.env.CUED_IMESSAGE_DB_PATH || undefined,
            lastRowId: Number(process.env.CUED_IMESSAGE_LAST_ROWID || "0"),
        });
        const output = { ok: true, bundle };
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
void main();
//# sourceMappingURL=imessage-worker.js.map