import { spawn } from "node:child_process";
import { getAdapterDefinition } from "./registry.js";
export async function runAdapter(platform, envOverrides) {
    const definition = getAdapterDefinition(platform);
    if (!definition) {
        throw new Error(`No adapter registered for platform '${platform}'`);
    }
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [definition.workerEntrypoint], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...envOverrides },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(stderr || `Adapter worker exited with code ${code}`));
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(stdout);
            }
            catch (error) {
                reject(new Error(`Invalid adapter worker output: ${error instanceof Error ? error.message : String(error)}`));
                return;
            }
            if (!parsed.ok || !parsed.bundle) {
                reject(new Error(parsed.error ?? "Adapter worker failed without output"));
                return;
            }
            resolve(parsed.bundle);
        });
    });
}
//# sourceMappingURL=runner.js.map