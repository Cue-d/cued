import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getManagedChromium,
  managedBrowserRoot,
  readChromiumRuntimeManifest,
} from "./managed-browser.js";

/**
 * A Chromium-family browser that sign-in windows can be opened in. `id` names the browser's
 * own profile directory: profiles are not shared between browsers, because a profile last
 * opened by a newer build fails to launch in an older one, and cookies written by one browser
 * are not readable by another.
 */
export interface AuthBrowser {
  id: string;
  name: string;
  executablePath: string;
  source: "configured" | "installed" | "managed";
  version: string | null;
}

const INSTALLED_BROWSERS = [
  { id: "google-chrome", name: "Google Chrome" },
  { id: "chromium", name: "Chromium" },
  { id: "microsoft-edge", name: "Microsoft Edge" },
  { id: "brave-browser", name: "Brave Browser" },
] as const;

export interface BrowserLookup {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
}

/** Every location Cued looks for an installed browser, in preference order. */
export function installedBrowserCandidates(home = homedir()): Omit<AuthBrowser, "version">[] {
  return INSTALLED_BROWSERS.flatMap((browser) =>
    ["/Applications", join(home, "Applications")].map((root) => ({
      id: browser.id,
      name: browser.name,
      executablePath: join(root, `${browser.name}.app`, "Contents", "MacOS", browser.name),
      source: "installed" as const,
    })),
  );
}

/** Reads the app version from the bundle's Info.plist, which Chromium browsers ship as XML. */
export function readAppVersion(executablePath: string): string | null {
  try {
    const plist = readFileSync(join(executablePath, "..", "..", "Info.plist"), "utf8");
    return (
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Browsers to try for a sign-in window, in order. An explicit CUED_CHROMIUM_EXECUTABLE_PATH is
 * the only candidate when set. Otherwise installed browsers come first, then Cued's downloaded
 * Chromium if it is already present. Downloading it is left to the caller.
 */
export function listAuthBrowsers(lookup: BrowserLookup = {}): AuthBrowser[] {
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? existsSync;
  const configured = env.CUED_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (configured) {
    return [
      {
        id: "configured",
        name: "Configured browser",
        executablePath: configured,
        source: "configured",
        version: null,
      },
    ];
  }

  const installed = installedBrowserCandidates(lookup.home)
    .filter((candidate) => exists(candidate.executablePath))
    .map((candidate) => ({ ...candidate, version: readAppVersion(candidate.executablePath) }));
  const managed = getManagedChromium(env, exists);
  return managed ? [...installed, managed] : installed;
}

export function authBrowserProfileDir(baseProfileDir: string, browser: AuthBrowser): string {
  return join(baseProfileDir, browser.id);
}

export const NO_BROWSER_REMEDIATION =
  "Install Google Chrome, Microsoft Edge, Brave Browser or Chromium, then try signing in again.";

export interface AuthBrowserStatus {
  /** The browser the next sign-in window will try first, or null when none is available. */
  selected: AuthBrowser | null;
  candidates: AuthBrowser[];
  /** Cued's own Chromium, downloaded on first use when no installed browser works. */
  fallback: {
    available: boolean;
    installed: boolean;
    version: string | null;
    directory: string;
  };
}

export function getAuthBrowserStatus(lookup: BrowserLookup = {}): AuthBrowserStatus {
  const env = lookup.env ?? process.env;
  const candidates = listAuthBrowsers(lookup);
  const manifest = readChromiumRuntimeManifest(env);
  const configured = Boolean(env.CUED_CHROMIUM_EXECUTABLE_PATH?.trim());
  return {
    selected: candidates[0] ?? null,
    candidates,
    fallback: {
      available: !configured && manifest !== null,
      installed: getManagedChromium(env, lookup.exists) !== null,
      version: manifest?.browserVersion ?? null,
      directory: managedBrowserRoot(env),
    },
  };
}
