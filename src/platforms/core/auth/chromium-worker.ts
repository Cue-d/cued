import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readlinkSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type BrowserContext, type Cookie, chromium, type Page, type Request } from "playwright";
import { cuedAuthKeychainService } from "../../../core/identity.js";

declare const localStorage: {
  getItem(key: string): string | null;
};

type Platform = "slack" | "linkedin" | "discord";
type AuthState = "authenticated" | "failed" | "cancelled";

type WorkerArgs = {
  platform: Platform;
  accountKey: string;
  sessionId: string;
  profileDir: string;
  launchTarget: string;
};

type WorkerResult = {
  sessionId: string;
  platform: Platform;
  accountKey: string;
  state: AuthState;
  keychainService: string | null;
  keychainAccount: string | null;
  resultSummary: Record<string, unknown> | null;
  errorSummary: string | null;
};

type ExtractedAuth = {
  keychainService: string;
  keychainAccount: string;
  secret: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
};

const REQUIRED_ARGS = new Set([
  "--platform",
  "--account-key",
  "--session-id",
  "--profile-dir",
  "--launch-target",
]);

function parseArgs(argv: string[]): WorkerArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!REQUIRED_ARGS.has(key) || !value) {
      throw new Error(`Invalid argument sequence at ${key ?? "end"}`);
    }
    values.set(key, value);
  }

  const platform = values.get("--platform");
  if (platform !== "slack" && platform !== "linkedin" && platform !== "discord") {
    throw new Error(`Unsupported chromium auth platform: ${platform ?? "missing"}`);
  }

  return {
    platform,
    accountKey: values.get("--account-key")!,
    sessionId: values.get("--session-id")!,
    profileDir: values.get("--profile-dir")!,
    launchTarget: values.get("--launch-target")!,
  };
}

function getTimeoutMs(): number {
  const configured = Number(process.env.CUED_CHROMIUM_AUTH_TIMEOUT_MS ?? 15 * 60_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 15 * 60_000;
}

function getExecutablePath(): string | undefined {
  return process.env.CUED_CHROMIUM_EXECUTABLE_PATH || undefined;
}

function bringAuthBrowserToFront(): void {
  try {
    execFileSync(
      "osascript",
      ["-e", 'tell application id "com.google.chrome.for.testing" to activate'],
      {
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
  } catch {
    // Best-effort only: auth can still proceed if macOS refuses activation.
  }
}

function parseSingletonPid(linkTarget: string): number | null {
  const match = /-(\d+)$/.exec(linkTarget);
  if (!match) {
    return null;
  }
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cleanupStaleChromiumSingleton(profileDir: string): void {
  const lockPath = join(profileDir, "SingletonLock");
  try {
    lstatSync(lockPath);
  } catch {
    return;
  }

  let ownerPid: number | null = null;
  try {
    ownerPid = parseSingletonPid(readlinkSync(lockPath));
  } catch {
    ownerPid = null;
  }
  if (ownerPid != null && isProcessAlive(ownerPid)) {
    return;
  }

  for (const name of [
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "RunningChromeVersion",
  ]) {
    const path = join(profileDir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        rmSync(path, { force: true, recursive: true });
      } else {
        unlinkSync(path);
      }
    } catch {
      // Already gone.
    }
  }
}

function storeInKeychain(service: string, account: string, secret: Record<string, unknown>): void {
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-s", service, "-a", account, "-w", JSON.stringify(secret)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

function domainMatches(cookie: Cookie, suffix: string): boolean {
  const domain = cookie.domain.replace(/^\./, "");
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

function firstOpenPage(context: BrowserContext): Page | null {
  for (const page of context.pages().reverse()) {
    if (!page.isClosed()) {
      return page;
    }
  }
  return null;
}

function isSlackWorkspaceUrl(url: string): boolean {
  return (
    url.startsWith("https://app.slack.com") ||
    /^https:\/\/[a-z0-9-]+\.slack\.com\/(client|messages|archives)/i.test(url)
  );
}

async function continueSlackInBrowser(page: Page): Promise<void> {
  if (!page.url().includes("slack.com")) {
    return;
  }

  const continueControl = page
    .getByRole("button", { name: /continue in browser/i })
    .or(page.getByRole("link", { name: /continue in browser/i }))
    .first();
  if ((await continueControl.count().catch(() => 0)) === 0) {
    return;
  }

  await continueControl.click({ timeout: 1_000 }).catch(() => {});
}

function isLinkedInAuthPage(url: string): boolean {
  return url.includes("/login") || url.includes("/authwall") || url.includes("/checkpoint");
}

function isLinkedInMessagingUrl(url: string): boolean {
  return /linkedin\.com\/messaging/i.test(url);
}

function isDiscordAppUrl(url: string): boolean {
  return /^https:\/\/(ptb\.|canary\.)?discord\.com\/(app|channels)\b/i.test(url);
}

async function fetchDiscordCurrentUser(token: string): Promise<{
  id: string;
  username: string;
  global_name?: string | null;
}> {
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: token,
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Cued/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Discord auth verification failed (${response.status})`);
  }
  return (await response.json()) as {
    id: string;
    username: string;
    global_name?: string | null;
  };
}

type LinkedInCapture = {
  pageInstance: string | null;
  xLiTrack: string | null;
  serviceVersion: string | null;
  realtimeQueryMap: string | null;
  realtimeRecipeMap: string | null;
};

function captureLinkedInHeaders(capture: LinkedInCapture, request: Request): void {
  if (!request.url().includes("linkedin.com")) {
    return;
  }

  const headers = request.headers();
  if (!capture.pageInstance && typeof headers["x-li-page-instance"] === "string") {
    capture.pageInstance = headers["x-li-page-instance"];
  }
  if (!capture.xLiTrack && typeof headers["x-li-track"] === "string") {
    capture.xLiTrack = headers["x-li-track"];
    try {
      const parsed = JSON.parse(headers["x-li-track"]) as Record<string, unknown>;
      if (typeof parsed.mpVersion === "string") {
        capture.serviceVersion = parsed.mpVersion;
      } else if (typeof parsed.clientVersion === "string") {
        capture.serviceVersion = parsed.clientVersion;
      }
    } catch {
      capture.serviceVersion = null;
    }
  }
  if (request.url().includes("/realtime/connect")) {
    if (!capture.realtimeQueryMap && typeof headers["x-li-query-map"] === "string") {
      capture.realtimeQueryMap = headers["x-li-query-map"];
    }
    if (!capture.realtimeRecipeMap && typeof headers["x-li-recipe-map"] === "string") {
      capture.realtimeRecipeMap = headers["x-li-recipe-map"];
    }
  }
}

async function captureLinkedInSessionData(
  context: BrowserContext,
  page: Page,
): Promise<LinkedInCapture> {
  const capture: LinkedInCapture = {
    pageInstance: null,
    xLiTrack: null,
    serviceVersion: null,
    realtimeQueryMap: null,
    realtimeRecipeMap: null,
  };
  const onRequest = (request: Request) => {
    captureLinkedInHeaders(capture, request);
  };
  context.on("request", onRequest);
  try {
    if (!isLinkedInMessagingUrl(page.url())) {
      await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded" });
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(500);
    return capture;
  } finally {
    context.off("request", onRequest);
  }
}

async function extractSlackAuth(
  context: BrowserContext,
  page: Page,
  _accountKey: string,
): Promise<ExtractedAuth | null> {
  if (!isSlackWorkspaceUrl(page.url())) {
    return null;
  }

  const localConfigRaw = await page
    .evaluate(() => localStorage.getItem("localConfig_v2"))
    .catch(() => null);
  if (!localConfigRaw) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(localConfigRaw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const teams =
    typeof parsed.teams === "object" && parsed.teams
      ? (parsed.teams as Record<string, Record<string, unknown>>)
      : {};
  const teamEntry = Object.entries(teams).find(
    ([, team]) => typeof team?.token === "string" && team.token.startsWith("xoxc-"),
  );
  if (!teamEntry) {
    return null;
  }

  const [teamId, team] = teamEntry;
  const cookies = await context.cookies(["https://slack.com", "https://app.slack.com"]);
  const dCookie = cookies.find(
    (cookie) => cookie.name === "d" && domainMatches(cookie, "slack.com"),
  );
  if (!dCookie?.value) {
    return null;
  }

  const teamName = typeof team.name === "string" ? team.name : teamId;
  const userId = typeof team.user_id === "string" ? team.user_id : "";
  return {
    keychainService: cuedAuthKeychainService("slack"),
    keychainAccount: teamId,
    secret: {
      token: team.token,
      cookie: dCookie.value,
      teamId,
      teamName,
      userId,
      savedAt: Date.now(),
    },
    resultSummary: {
      provider: "slack",
      teamId,
      teamName,
      userId,
      cookieNames: cookies.map((cookie) => cookie.name).sort(),
    },
  };
}

async function extractLinkedInAuth(
  context: BrowserContext,
  page: Page,
  accountKey: string,
): Promise<ExtractedAuth | null> {
  if (isLinkedInAuthPage(page.url())) {
    return null;
  }

  const cookies = await context.cookies(["https://www.linkedin.com", "https://linkedin.com"]);
  const liAt = cookies.find(
    (cookie) => cookie.name === "li_at" && domainMatches(cookie, "linkedin.com"),
  );
  const jsession = cookies.find(
    (cookie) => cookie.name === "JSESSIONID" && domainMatches(cookie, "linkedin.com"),
  );
  if (!liAt?.value || !jsession?.value) {
    return null;
  }

  const captured = await captureLinkedInSessionData(context, page);
  const realtimeReady = Boolean(
    captured.pageInstance &&
      captured.xLiTrack &&
      captured.realtimeQueryMap &&
      captured.realtimeRecipeMap,
  );

  return {
    keychainService: cuedAuthKeychainService("linkedin"),
    keychainAccount: accountKey,
    secret: {
      cookies: cookies
        .filter((cookie) => domainMatches(cookie, "linkedin.com"))
        .map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
        })),
      pageInstance: captured.pageInstance,
      xLiTrack: captured.xLiTrack,
      serviceVersion: captured.serviceVersion,
      realtimeQueryMap: captured.realtimeQueryMap,
      realtimeRecipeMap: captured.realtimeRecipeMap,
      savedAt: Date.now(),
    },
    resultSummary: {
      provider: "linkedin",
      cookieCount: cookies.length,
      currentUrl: page.url(),
      realtimeReady,
      pageInstanceCaptured: Boolean(captured.pageInstance),
      xLiTrackCaptured: Boolean(captured.xLiTrack),
      realtimeQueryMapCaptured: Boolean(captured.realtimeQueryMap),
      realtimeRecipeMapCaptured: Boolean(captured.realtimeRecipeMap),
      serviceVersion: captured.serviceVersion,
    },
  };
}

async function extractDiscordAuth(
  context: BrowserContext,
  page: Page,
  accountKey: string,
): Promise<ExtractedAuth | null> {
  if (!isDiscordAppUrl(page.url())) {
    return null;
  }

  const storageState = await context.storageState();
  const discordOrigin = storageState.origins.find((origin) =>
    /^https:\/\/(ptb\.|canary\.)?discord\.com$/i.test(origin.origin),
  );
  const tokenRaw =
    discordOrigin?.localStorage.find((entry) => entry.name === "token")?.value ?? null;
  if (typeof tokenRaw !== "string" || tokenRaw.length === 0) {
    throw new Error("Discord token missing from localStorage");
  }

  const token = tokenRaw.replace(/^"|"$/g, "").trim();
  if (!token || token === "null") {
    throw new Error("Discord token was empty after normalization");
  }

  const me = await fetchDiscordCurrentUser(token);

  return {
    keychainService: cuedAuthKeychainService("discord"),
    keychainAccount: accountKey,
    secret: {
      token,
      userId: me.id,
      username: me.username,
      globalName: me.global_name ?? null,
      savedAt: Date.now(),
    },
    resultSummary: {
      provider: "discord",
      userId: me.id,
      username: me.username,
      globalName: me.global_name ?? null,
      displayName: me.global_name ?? me.username,
      currentUrl: page.url(),
    },
  };
}

async function maybeExtractAuth(
  args: WorkerArgs,
  context: BrowserContext,
  page: Page,
): Promise<ExtractedAuth | null> {
  switch (args.platform) {
    case "slack":
      return extractSlackAuth(context, page, args.accountKey);
    case "discord":
      return extractDiscordAuth(context, page, args.accountKey);
    case "linkedin":
      return extractLinkedInAuth(context, page, args.accountKey);
  }
}

function listOpenPages(context: BrowserContext): Page[] {
  return context.pages().filter((page) => !page.isClosed());
}

function getFakeResult(args: WorkerArgs): WorkerResult | null {
  const raw = process.env.CUED_FAKE_CHROMIUM_AUTH_RESULT;
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    sessionId: args.sessionId,
    platform: args.platform,
    accountKey: args.accountKey,
    state:
      parsed.state === "authenticated"
        ? "authenticated"
        : parsed.state === "cancelled"
          ? "cancelled"
          : "failed",
    keychainService: typeof parsed.keychainService === "string" ? parsed.keychainService : null,
    keychainAccount:
      typeof parsed.keychainAccount === "string" ? parsed.keychainAccount : args.accountKey,
    resultSummary:
      typeof parsed.resultSummary === "object" && parsed.resultSummary
        ? (parsed.resultSummary as Record<string, unknown>)
        : { provider: args.platform, fake: true },
    errorSummary: typeof parsed.errorSummary === "string" ? parsed.errorSummary : null,
  };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fake = getFakeResult(args);
  if (fake) {
    process.stdout.write(JSON.stringify(fake));
    return;
  }

  mkdirSync(args.profileDir, { recursive: true });
  cleanupStaleChromiumSingleton(args.profileDir);
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(args.profileDir, {
      headless: false,
      executablePath: getExecutablePath(),
      args: ["--disable-blink-features=AutomationControlled"],
      viewport: { width: 1280, height: 900 },
    });

    let page = firstOpenPage(context) ?? (await context.newPage());
    if (!page.url() || page.url() === "about:blank") {
      await page.goto(args.launchTarget, { waitUntil: "domcontentloaded" });
    }
    await page.bringToFront().catch(() => {});
    bringAuthBrowserToFront();

    const deadline = Date.now() + getTimeoutMs();
    let lastObservedUrls: string[] = [];
    let lastExtractionError: string | null = null;
    while (Date.now() < deadline) {
      const openPages = listOpenPages(context);
      page = firstOpenPage(context) ?? page;
      lastObservedUrls = openPages.map((openPage) => openPage.url());
      if (openPages.length === 0 || !page || page.isClosed()) {
        const cancelled: WorkerResult = {
          sessionId: args.sessionId,
          platform: args.platform,
          accountKey: args.accountKey,
          state: "cancelled",
          keychainService: null,
          keychainAccount: null,
          resultSummary: null,
          errorSummary: "Login window closed before authentication completed",
        };
        process.stdout.write(JSON.stringify(cancelled));
        return;
      }

      for (const candidatePage of openPages) {
        try {
          if (args.platform === "slack") {
            await continueSlackInBrowser(candidatePage);
          }
          const extracted = await maybeExtractAuth(args, context, candidatePage);
          if (!extracted) {
            continue;
          }
          storeInKeychain(extracted.keychainService, extracted.keychainAccount, extracted.secret);
          const result: WorkerResult = {
            sessionId: args.sessionId,
            platform: args.platform,
            accountKey: extracted.keychainAccount,
            state: "authenticated",
            keychainService: extracted.keychainService,
            keychainAccount: extracted.keychainAccount,
            resultSummary: {
              ...extracted.resultSummary,
              profileDir: args.profileDir,
            },
            errorSummary: null,
          };
          await context.close();
          process.stdout.write(JSON.stringify(result));
          return;
        } catch (error) {
          lastExtractionError = error instanceof Error ? error.message : String(error);
        }
      }

      await page.waitForTimeout(1000);
    }

    const failed: WorkerResult = {
      sessionId: args.sessionId,
      platform: args.platform,
      accountKey: args.accountKey,
      state: "failed",
      keychainService: null,
      keychainAccount: null,
      resultSummary: {
        provider: args.platform,
        profileDir: args.profileDir,
        pageUrls: lastObservedUrls,
      },
      errorSummary:
        `Timed out waiting for ${args.platform} authentication` +
        (lastExtractionError ? ` (${lastExtractionError})` : ""),
    };
    process.stdout.write(JSON.stringify(failed));
  } finally {
    await context?.close().catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
