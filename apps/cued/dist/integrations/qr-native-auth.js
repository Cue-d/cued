import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
function parseFakeResult(session, integration) {
    const raw = process.env.CUED_FAKE_QR_AUTH_RESULT;
    if (!raw) {
        return null;
    }
    const parsed = JSON.parse(raw);
    return {
        sessionId: session.id,
        platform: session.platform,
        accountKey: session.accountKey,
        state: parsed.state === "authenticated" ? "authenticated" : parsed.state === "cancelled" ? "cancelled" : "failed",
        keychainService: typeof parsed.keychainService === "string" ? parsed.keychainService : null,
        keychainAccount: typeof parsed.keychainAccount === "string" ? parsed.keychainAccount : session.accountKey,
        resultSummary: {
            runtime: "qr_native",
            integration: `${integration.platform}/${integration.accountKey}`,
            ...(typeof parsed.resultSummary === "object" && parsed.resultSummary
                ? parsed.resultSummary
                : {}),
        },
        errorSummary: typeof parsed.errorSummary === "string" ? parsed.errorSummary : null,
    };
}
export function startQrNativeAuthSession(_db, session, integration) {
    const fake = parseFakeResult(session, integration);
    if (fake) {
        const child = spawn("sh", ["-lc", "exit 0"], { stdio: "ignore" });
        return {
            child,
            completion: Promise.resolve(fake),
        };
    }
    const errorSummary = `QR auth runtime not implemented yet for ${integration.platform}; set CUED_FAKE_QR_AUTH_RESULT for tests`;
    const child = spawn("sh", ["-lc", "exit 1"], { stdio: "ignore" });
    return {
        child,
        completion: Promise.resolve({
            sessionId: session.id,
            platform: session.platform,
            accountKey: session.accountKey,
            state: "failed",
            keychainService: null,
            keychainAccount: null,
            resultSummary: {
                runtime: "qr_native",
                stub: true,
                ticket: randomUUID(),
            },
            errorSummary,
        }),
    };
}
export async function runQrNativeAuthSessionSync(db, session, integration) {
    const handle = startQrNativeAuthSession(db, session, integration);
    return handle.completion;
}
//# sourceMappingURL=qr-native-auth.js.map