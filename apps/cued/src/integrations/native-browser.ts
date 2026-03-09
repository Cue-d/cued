import { execFileSync } from "node:child_process";
import { resolveMacOSNativeBinary } from "../workers/native-binary.js";

export function openNativeBrowserURL(url: string): string[] {
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

export function closeNativeBrowserTabsByPrefix(urlPrefix: string): { command: string[] | null; closedTabs: number | null } {
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
  const parsed = JSON.parse(stdout) as { closedTabs?: number };
  return {
    command: [nativeBinary, "browser", "close", "--url-prefix", urlPrefix],
    closedTabs: parsed.closedTabs ?? 0,
  };
}
