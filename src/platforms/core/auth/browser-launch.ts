import { type AuthBrowser, NO_BROWSER_REMEDIATION } from "./browser-resolver.js";

/** The attempt recorded when Cued's own Chromium could not be downloaded. */
const DOWNLOAD_ATTEMPT = "Chromium download";

export interface BrowserLaunchAttempt {
  browser: string;
  error: string;
}

export class BrowserUnavailableError extends Error {
  constructor(
    readonly attempts: BrowserLaunchAttempt[],
    reason: string,
    remediation = NO_BROWSER_REMEDIATION,
  ) {
    super(`${reason} ${remediation}`);
    this.name = "BrowserUnavailableError";
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.slice(0, 300) ?? "";
}

/**
 * Tries each candidate browser in order and returns the first that launches. When none does,
 * Cued's own Chromium is installed (downloaded on first use) and tried last, unless
 * `installManaged` is null because the browser was set explicitly.
 */
export async function launchFirstAvailableBrowser<T>(input: {
  candidates: AuthBrowser[];
  launch: (browser: AuthBrowser) => Promise<T>;
  installManaged: (() => Promise<AuthBrowser>) | null;
}): Promise<{ result: T; browser: AuthBrowser; attempts: BrowserLaunchAttempt[] }> {
  const attempts: BrowserLaunchAttempt[] = [];
  const tried = new Set<string>();
  const tryEach = async (browsers: AuthBrowser[]) => {
    for (const browser of browsers) {
      if (tried.has(browser.executablePath)) continue;
      tried.add(browser.executablePath);
      try {
        return { result: await input.launch(browser), browser, attempts };
      } catch (error) {
        attempts.push({ browser: browser.name, error: firstLine(error) });
      }
    }
    return null;
  };

  const launched = await tryEach(input.candidates);
  if (launched) return launched;
  if (!input.installManaged) {
    throw new BrowserUnavailableError(
      attempts,
      "The browser set in CUED_CHROMIUM_EXECUTABLE_PATH could not be opened for the sign-in window.",
      "Fix or unset CUED_CHROMIUM_EXECUTABLE_PATH.",
    );
  }

  let managed: AuthBrowser;
  try {
    managed = await input.installManaged();
  } catch (error) {
    attempts.push({ browser: DOWNLOAD_ATTEMPT, error: firstLine(error) });
    throw new BrowserUnavailableError(
      attempts,
      attempts.length > 1
        ? "No installed browser could be opened, and Chromium could not be downloaded."
        : "No supported browser was found, and Chromium could not be downloaded.",
    );
  }
  const fallback = await tryEach([managed]);
  if (fallback) return fallback;
  throw new BrowserUnavailableError(attempts, "No browser could be opened for the sign-in window.");
}

/**
 * One sentence for the app: why no sign-in window opened and what to do. A failed download or
 * checksum is named as such, since trying again can fix it; otherwise the full reason is kept.
 */
export function describeBrowserSetupFailure(error: BrowserUnavailableError): string {
  const download = error.attempts.find((attempt) => attempt.browser === DOWNLOAD_ATTEMPT);
  if (!download) return error.message;
  const alternative =
    "Try again, or install Google Chrome, Microsoft Edge, Brave Browser or Chromium.";
  if (/checksum/i.test(download.error)) {
    return `The downloaded sign-in browser did not match its expected checksum, so it was not used. ${alternative}`;
  }
  const detail = download.error.replace(/\.$/, "");
  return `The sign-in browser could not be downloaded (${detail}). ${alternative}`;
}
