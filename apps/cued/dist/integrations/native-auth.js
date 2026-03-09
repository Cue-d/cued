import { execFileSync, spawn } from "node:child_process";
import { resolveMacOSNativeBinary } from "../workers/native-binary.js";
function resolveNativeAuthBinary() {
    const binary = resolveMacOSNativeBinary(process.env.CUED_AUTH_NATIVE_BINARY ?? process.env.CUED_CONTACTS_NATIVE_BINARY);
    if (!binary) {
        throw new Error("CuedNative binary not found; build native/macos/CuedNative first");
    }
    return binary;
}
function buildNativeAuthArgs(db, session) {
    return [
        "auth",
        "open",
        "--platform",
        session.platform,
        "--account-key",
        session.accountKey,
        "--session-id",
        session.id,
        "--db-path",
        db.dbPath,
    ];
}
function parseNativeAuthOutput(stdout) {
    return JSON.parse(stdout);
}
export function startNativeAuthSession(db, session) {
    const binary = resolveNativeAuthBinary();
    const args = buildNativeAuthArgs(db, session);
    const child = spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    const completion = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
            const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
            const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
            if (code === 0 && stdout.length > 0) {
                try {
                    resolve(parseNativeAuthOutput(stdout));
                    return;
                }
                catch (error) {
                    reject(error);
                    return;
                }
            }
            reject(new Error(stderr || stdout || `Native auth helper exited with code ${code ?? "unknown"}`));
        });
    });
    return { child, completion };
}
export function runNativeAuthSessionSync(db, session) {
    const binary = resolveNativeAuthBinary();
    const stdout = execFileSync(binary, buildNativeAuthArgs(db, session), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return parseNativeAuthOutput(stdout);
}
//# sourceMappingURL=native-auth.js.map