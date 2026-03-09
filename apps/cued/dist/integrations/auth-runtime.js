import { startChromiumAuthSession, runChromiumAuthSessionSync } from "./chromium-auth.js";
import { startNativeAuthSession, runNativeAuthSessionSync } from "./native-auth.js";
import { startQrNativeAuthSession, runQrNativeAuthSessionSync } from "./qr-native-auth.js";
export function startAuthSession(db, session, integration) {
    switch (integration.runtimeKind) {
        case "chromium":
            return startChromiumAuthSession(db, session, integration);
        case "qr_native":
            return startQrNativeAuthSession(db, session, integration);
        case "native":
            return startNativeAuthSession(db, session);
        default:
            throw new Error(`Unsupported auth runtime: ${integration.runtimeKind}`);
    }
}
export async function runAuthSessionSync(db, session, integration) {
    switch (integration.runtimeKind) {
        case "chromium":
            return runChromiumAuthSessionSync(db, session, integration);
        case "qr_native":
            return runQrNativeAuthSessionSync(db, session, integration);
        case "native":
            return runNativeAuthSessionSync(db, session);
        default:
            throw new Error(`Unsupported auth runtime: ${integration.runtimeKind}`);
    }
}
//# sourceMappingURL=auth-runtime.js.map