import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getManagedChromiumBrowser } from "./managed-browser.js";

export interface BrowserCandidate {
  name: string;
  executablePath: string;
  appBundleIdentifier: string;
}

function appExecutablePath(appRoot: string, appName: string, executableName: string): string {
  return join(appRoot, `${appName}.app`, "Contents", "MacOS", executableName);
}

function macOSBrowserCandidatesForAppRoot(appRoot: string): BrowserCandidate[] {
  return [
    {
      name: "Google Chrome",
      executablePath: appExecutablePath(appRoot, "Google Chrome", "Google Chrome"),
      appBundleIdentifier: "com.google.Chrome",
    },
    {
      name: "Chromium",
      executablePath: appExecutablePath(appRoot, "Chromium", "Chromium"),
      appBundleIdentifier: "org.chromium.Chromium",
    },
    {
      name: "Microsoft Edge",
      executablePath: appExecutablePath(appRoot, "Microsoft Edge", "Microsoft Edge"),
      appBundleIdentifier: "com.microsoft.edgemac",
    },
    {
      name: "Brave Browser",
      executablePath: appExecutablePath(appRoot, "Brave Browser", "Brave Browser"),
      appBundleIdentifier: "com.brave.Browser",
    },
  ];
}

export const MACOS_BROWSER_CANDIDATES: BrowserCandidate[] = [
  ...macOSBrowserCandidatesForAppRoot("/Applications"),
  ...macOSBrowserCandidatesForAppRoot(join(homedir(), "Applications")),
];

export function listInstalledChromiumAuthBrowsers(
  env: NodeJS.ProcessEnv = process.env,
  candidates: BrowserCandidate[] = MACOS_BROWSER_CANDIDATES,
): BrowserCandidate[] {
  const configured = env.CUED_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (configured) {
    return [
      {
        name: "Configured Chromium browser",
        executablePath: configured,
        appBundleIdentifier: env.CUED_CHROMIUM_APP_BUNDLE_IDENTIFIER?.trim() || "com.google.Chrome",
      },
    ];
  }

  return candidates.filter((candidate) => existsSync(candidate.executablePath));
}

export function listAvailableChromiumAuthBrowsers(
  env: NodeJS.ProcessEnv = process.env,
  candidates: BrowserCandidate[] = MACOS_BROWSER_CANDIDATES,
): BrowserCandidate[] {
  const installed = listInstalledChromiumAuthBrowsers(env, candidates);
  let managed: BrowserCandidate | null = null;
  try {
    managed = getManagedChromiumBrowser(env);
  } catch {
    managed = null;
  }
  return managed ? [...installed, managed] : installed;
}

export function resolveChromiumAuthBrowser(
  env: NodeJS.ProcessEnv = process.env,
  candidates: BrowserCandidate[] = MACOS_BROWSER_CANDIDATES,
): BrowserCandidate | null {
  return listAvailableChromiumAuthBrowsers(env, candidates)[0] ?? null;
}

export function formatMissingChromiumAuthBrowserError(): string {
  return [
    "No supported browser was available for Cued browser authentication.",
    "Install Google Chrome, Chromium, Microsoft Edge, or Brave Browser, or run `cued browser install` to install Cued's managed Chromium.",
  ].join(" ");
}
