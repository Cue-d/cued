import { execFileSync } from "node:child_process";
import { resolveMacOSNativeBinary } from "../workers/native-binary.js";
export function openNativeBrowserURL(url) {
    const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_CONTACTS_NATIVE_BINARY);
    if (nativeBinary) {
        execFileSync(nativeBinary, ["browser", "open", "--url", url], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        return [nativeBinary, "browser", "open", "--url", url];
    }
    execFileSync("open", [url], { stdio: "ignore" });
    return ["open", url];
}
export function closeNativeBrowserTabsByPrefix(urlPrefix) {
    const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_CONTACTS_NATIVE_BINARY);
    if (!nativeBinary) {
        return {
            command: null,
            closedTabs: null,
        };
    }
    const stdout = execFileSync(nativeBinary, ["browser", "close", "--url-prefix", urlPrefix], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(stdout);
    return {
        command: [nativeBinary, "browser", "close", "--url-prefix", urlPrefix],
        closedTabs: parsed.closedTabs ?? 0,
    };
}
//# sourceMappingURL=native-browser.js.map