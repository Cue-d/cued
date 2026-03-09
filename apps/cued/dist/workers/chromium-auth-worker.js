import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
const REQUIRED_ARGS = new Set([
    "--platform",
    "--account-key",
    "--session-id",
    "--profile-dir",
    "--launch-target",
]);
function parseArgs(argv) {
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!REQUIRED_ARGS.has(key) || !value) {
            throw new Error(`Invalid argument sequence at ${key ?? "end"}`);
        }
        values.set(key, value);
    }
    const platform = values.get("--platform");
    if (platform !== "slack" && platform !== "linkedin" && platform !== "twitter") {
        throw new Error(`Unsupported chromium auth platform: ${platform ?? "missing"}`);
    }
    return {
        platform,
        accountKey: values.get("--account-key"),
        sessionId: values.get("--session-id"),
        profileDir: values.get("--profile-dir"),
        launchTarget: values.get("--launch-target"),
    };
}
function getTimeoutMs() {
    const configured = Number(process.env.CUED_CHROMIUM_AUTH_TIMEOUT_MS ?? 15 * 60_000);
    return Number.isFinite(configured) && configured > 0 ? configured : 15 * 60_000;
}
function getExecutablePath() {
    return process.env.CUED_CHROMIUM_EXECUTABLE_PATH || undefined;
}
function storeInKeychain(service, account, secret) {
    execFileSync("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", JSON.stringify(secret)], { stdio: ["ignore", "ignore", "pipe"] });
}
function domainMatches(cookie, suffix) {
    const domain = cookie.domain.replace(/^\./, "");
    return domain === suffix || domain.endsWith(`.${suffix}`);
}
function firstOpenPage(context) {
    for (const page of context.pages().reverse()) {
        if (!page.isClosed()) {
            return page;
        }
    }
    return null;
}
function isSlackWorkspaceUrl(url) {
    return url.startsWith("https://app.slack.com")
        || /^https:\/\/[a-z0-9-]+\.slack\.com\/(client|messages|archives)/i.test(url);
}
function isLinkedInAuthPage(url) {
    return url.includes("/login") || url.includes("/authwall") || url.includes("/checkpoint");
}
function isTwitterAuthPage(url) {
    return url.includes("/login")
        || url.includes("/i/flow/login")
        || url.includes("/account/access")
        || url.includes("/account/login_challenge");
}
async function extractSlackAuth(context, page, accountKey) {
    if (!isSlackWorkspaceUrl(page.url())) {
        return null;
    }
    let localConfigRaw = null;
    try {
        localConfigRaw = await page.evaluate(() => localStorage.getItem("localConfig_v2"));
    }
    catch {
        return null;
    }
    if (!localConfigRaw) {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(localConfigRaw);
    }
    catch {
        return null;
    }
    const teams = typeof parsed.teams === "object" && parsed.teams
        ? parsed.teams
        : {};
    const teamEntry = Object.entries(teams).find(([, team]) => typeof team?.token === "string" && team.token.startsWith("xoxc-"));
    if (!teamEntry) {
        return null;
    }
    const [teamId, team] = teamEntry;
    const cookies = await context.cookies(["https://slack.com", "https://app.slack.com"]);
    const dCookie = cookies.find((cookie) => cookie.name === "d" && domainMatches(cookie, "slack.com"));
    if (!dCookie?.value) {
        return null;
    }
    const teamName = typeof team.name === "string" ? team.name : teamId;
    const userId = typeof team.user_id === "string" ? team.user_id : "";
    return {
        keychainService: "dev.cued.auth.slack",
        keychainAccount: accountKey,
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
async function extractLinkedInAuth(context, page, accountKey) {
    if (isLinkedInAuthPage(page.url())) {
        return null;
    }
    const cookies = await context.cookies(["https://www.linkedin.com", "https://linkedin.com"]);
    const liAt = cookies.find((cookie) => cookie.name === "li_at" && domainMatches(cookie, "linkedin.com"));
    const jsession = cookies.find((cookie) => cookie.name === "JSESSIONID" && domainMatches(cookie, "linkedin.com"));
    if (!liAt?.value || !jsession?.value) {
        return null;
    }
    return {
        keychainService: "dev.cued.auth.linkedin",
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
            savedAt: Date.now(),
        },
        resultSummary: {
            provider: "linkedin",
            cookieCount: cookies.length,
            currentUrl: page.url(),
        },
    };
}
async function extractTwitterAuth(context, page, accountKey) {
    if (isTwitterAuthPage(page.url())) {
        return null;
    }
    const cookies = await context.cookies(["https://x.com", "https://twitter.com"]);
    const authToken = cookies.find((cookie) => cookie.name === "auth_token" && (domainMatches(cookie, "x.com") || domainMatches(cookie, "twitter.com")));
    const ct0 = cookies.find((cookie) => cookie.name === "ct0" && (domainMatches(cookie, "x.com") || domainMatches(cookie, "twitter.com")));
    if (!authToken?.value || !ct0?.value) {
        return null;
    }
    return {
        keychainService: "dev.cued.auth.twitter",
        keychainAccount: accountKey,
        secret: {
            cookies: cookies
                .filter((cookie) => domainMatches(cookie, "x.com") || domainMatches(cookie, "twitter.com"))
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
            savedAt: Date.now(),
        },
        resultSummary: {
            provider: "twitter",
            cookieCount: cookies.length,
            currentUrl: page.url(),
        },
    };
}
async function maybeExtractAuth(args, context, page) {
    switch (args.platform) {
        case "slack":
            return extractSlackAuth(context, page, args.accountKey);
        case "linkedin":
            return extractLinkedInAuth(context, page, args.accountKey);
        case "twitter":
            return extractTwitterAuth(context, page, args.accountKey);
    }
}
function getFakeResult(args) {
    const raw = process.env.CUED_FAKE_CHROMIUM_AUTH_RESULT;
    if (!raw) {
        return null;
    }
    const parsed = JSON.parse(raw);
    return {
        sessionId: args.sessionId,
        platform: args.platform,
        accountKey: args.accountKey,
        state: parsed.state === "authenticated" ? "authenticated" : parsed.state === "cancelled" ? "cancelled" : "failed",
        keychainService: typeof parsed.keychainService === "string" ? parsed.keychainService : null,
        keychainAccount: typeof parsed.keychainAccount === "string" ? parsed.keychainAccount : args.accountKey,
        resultSummary: typeof parsed.resultSummary === "object" && parsed.resultSummary
            ? parsed.resultSummary
            : { provider: args.platform, fake: true },
        errorSummary: typeof parsed.errorSummary === "string" ? parsed.errorSummary : null,
    };
}
async function run() {
    const args = parseArgs(process.argv.slice(2));
    const fake = getFakeResult(args);
    if (fake) {
        process.stdout.write(JSON.stringify(fake));
        return;
    }
    mkdirSync(args.profileDir, { recursive: true });
    let context = null;
    try {
        context = await chromium.launchPersistentContext(args.profileDir, {
            headless: false,
            executablePath: getExecutablePath(),
            args: ["--disable-blink-features=AutomationControlled"],
            viewport: { width: 1280, height: 900 },
        });
        let page = firstOpenPage(context) ?? await context.newPage();
        if (!page.url() || page.url() === "about:blank") {
            await page.goto(args.launchTarget, { waitUntil: "domcontentloaded" });
        }
        const deadline = Date.now() + getTimeoutMs();
        while (Date.now() < deadline) {
            page = firstOpenPage(context) ?? page;
            if (!page || page.isClosed()) {
                const cancelled = {
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
            const extracted = await maybeExtractAuth(args, context, page);
            if (extracted) {
                storeInKeychain(extracted.keychainService, extracted.keychainAccount, extracted.secret);
                const result = {
                    sessionId: args.sessionId,
                    platform: args.platform,
                    accountKey: args.accountKey,
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
            }
            await page.waitForTimeout(1000);
        }
        const failed = {
            sessionId: args.sessionId,
            platform: args.platform,
            accountKey: args.accountKey,
            state: "failed",
            keychainService: null,
            keychainAccount: null,
            resultSummary: {
                provider: args.platform,
                profileDir: args.profileDir,
            },
            errorSummary: `Timed out waiting for ${args.platform} authentication`,
        };
        process.stdout.write(JSON.stringify(failed));
    }
    finally {
        await context?.close().catch(() => { });
    }
}
void run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
//# sourceMappingURL=chromium-auth-worker.js.map