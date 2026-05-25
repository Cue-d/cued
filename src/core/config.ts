import "./env.js";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterPlatform } from "./types/provider.js";

type ProjectionBacklogTier = {
  minEvents: number;
  batchSize: number;
  continueDelayMs: number | null;
};

type RuntimeConfigFile = {
  home?: unknown;
  dbPath?: unknown;
};

type FakeAuthRuntime = "chromium" | "qrNative";

const CORE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(CORE_DIR, "../..");
const CHROMIUM_EXECUTABLE_RELATIVE_PATH =
  "runtime/chromium/chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const DEFAULT_CUED_HOME = join(homedir(), ".cued");
const DEFAULT_CONFIG_FILE = join(DEFAULT_CUED_HOME, "config.json");
const CONFIG_ARG_NAMES = new Set(["--config", "--cued-config"]);

function trimPath(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runtimeConfigPathFromArgs(args: string[]): { path: string | null; explicit: boolean } {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (CONFIG_ARG_NAMES.has(arg)) {
      return { path: trimPath(args[index + 1]), explicit: true };
    }
    for (const name of CONFIG_ARG_NAMES) {
      const prefix = `${name}=`;
      if (arg.startsWith(prefix)) {
        return { path: trimPath(arg.slice(prefix.length)), explicit: true };
      }
    }
  }

  return { path: DEFAULT_CONFIG_FILE, explicit: false };
}

function readRuntimeConfig(args = process.argv.slice(2)): RuntimeConfigFile {
  const { path, explicit } = runtimeConfigPathFromArgs(args);
  if (!path) {
    return {};
  }
  if (!existsSync(path)) {
    if (explicit) {
      throw new Error(`Cued config file does not exist: ${path}`);
    }
    return {};
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeConfigFile;
  return parsed && typeof parsed === "object" ? parsed : {};
}

function runtimeConfigArgsFromArgs(args: string[]): string[] {
  const { path, explicit } = runtimeConfigPathFromArgs(args);
  return explicit && path ? ["--config", path] : [];
}

export function getRuntimeConfigArgs(): string[] {
  return runtimeConfigArgsFromArgs(process.argv.slice(2));
}

export function stripRuntimeConfigArgs(args: string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (CONFIG_ARG_NAMES.has(arg)) {
      index += 1;
      continue;
    }
    if ([...CONFIG_ARG_NAMES].some((name) => arg.startsWith(`${name}=`))) {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

export function resolveCuedHome(runtimeConfig: RuntimeConfigFile = readRuntimeConfig()): string {
  const configuredHome = trimPath(runtimeConfig.home);
  if (configuredHome) {
    return configuredHome;
  }

  const configuredDbPath = trimPath(runtimeConfig.dbPath);
  if (configuredDbPath) {
    return dirname(configuredDbPath);
  }

  return DEFAULT_CUED_HOME;
}

export function resolveCuedDbPath(runtimeConfig: RuntimeConfigFile = readRuntimeConfig()): string {
  return trimPath(runtimeConfig.dbPath) ?? join(resolveCuedHome(runtimeConfig), "local.db");
}

export function resolveChromiumExecutablePath(
  runtimeRoot = REPO_ROOT,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const candidates = [
    resolve(runtimeRoot, CHROMIUM_EXECUTABLE_RELATIVE_PATH),
    resolve(runtimeRoot, "..", CHROMIUM_EXECUTABLE_RELATIVE_PATH),
  ];
  return candidates.find(pathExists) ?? candidates[0]!;
}

const RUNTIME_CONFIG = readRuntimeConfig();

export const CUED_HOME = resolveCuedHome(RUNTIME_CONFIG);
export const CUED_DB_PATH = resolveCuedDbPath(RUNTIME_CONFIG);
export const CUED_SOCKET_PATH = join(CUED_HOME, "cued.sock");
export const CUED_DAEMON_LOCK_PATH = join(CUED_HOME, "daemon.lock");
export const CUED_MENU_BAR_LOCK_PATH = join(CUED_HOME, "menu-bar.lock");
export const CUED_MENU_BAR_STATUS_PATH = join(CUED_HOME, "menu-bar-status.json");
export const CUED_LOG_DIR = join(CUED_HOME, "logs");
export const CUED_DAEMON_LOG_PATH = join(CUED_LOG_DIR, "daemon.log");
export const CUED_BROWSER_DIR = join(CUED_HOME, "browser");
export const CUED_INTEGRATIONS_DIR = join(CUED_HOME, "integrations");
export const CUED_SIGNAL_DIR = join(CUED_INTEGRATIONS_DIR, "signal");
export const CUED_WHATSAPP_DIR = join(CUED_INTEGRATIONS_DIR, "whatsapp");
export const CUED_ATTACHMENTS_DIR = join(CUED_HOME, "attachments");
export const CUED_ATTACHMENTS_OBJECTS_DIR = join(CUED_ATTACHMENTS_DIR, "objects");
export const CUED_ATTACHMENTS_TMP_DIR = join(CUED_ATTACHMENTS_DIR, "tmp");
export const CUED_HOOKS_PATH = join(CUED_HOME, "hooks.toml");
export const CUED_UPDATES_DIR = join(CUED_HOME, "updates");
export const CUED_UPDATE_DOWNLOADS_DIR = join(CUED_UPDATES_DIR, "downloads");
export const CUED_UPDATE_ROLLBACK_DIR = join(CUED_UPDATES_DIR, "rollback");
export const CUED_BACKUPS_DIR = join(CUED_HOME, "backups");

const PLATFORM_AUTO_SYNC_INTERVAL_MS: Partial<Record<AdapterPlatform, number>> = {
  discord: 10 * 60_000,
  signal: 300_000,
  whatsapp: 300_000,
};

export const CONFIG = {
  app: {
    repoRoot: REPO_ROOT,
  },
  macOS: {
    currentAppPath: null as string | null,
  },
  nativeRuntime: {
    repoRoot: REPO_ROOT,
  },
  platformRuntime: {
    signalConfigRoot: CUED_SIGNAL_DIR,
  },
  daemon: {
    autoSyncPlatforms: null as AdapterPlatform[] | null,
    realtimePlatforms: null as AdapterPlatform[] | null,
    autoSyncIntervalMs: 60_000,
    platformAutoSyncIntervalMs: PLATFORM_AUTO_SYNC_INTERVAL_MS,
    autoSyncSchedulerTickMs: 15_000,
    ingestConcurrency: 4,
    projectionBatchSize: 100,
    projectionBacklogTiers: [
      { minEvents: 100_000, batchSize: 2_000, continueDelayMs: 0 },
      { minEvents: 25_000, batchSize: 1_500, continueDelayMs: 0 },
      { minEvents: 5_000, batchSize: 1_000, continueDelayMs: 0 },
      { minEvents: 1_000, batchSize: 500, continueDelayMs: null },
    ] satisfies ProjectionBacklogTier[],
    projectionContinueDelayMs: 5_000,
    projectionContinueDelayMsOverride: null as number | null,
    messageFtsIndexBatchSize: 250,
    realtimeProjectionEnabled: true,
    realtimeProjectionBatchSize: null as number | null,
    deferredProjectionCoalesceMs: 250,
    autoSyncProjectionBacklogPauseEvents: 5_000,
    syncContinueDelayMs: 15_000,
    signalReconnectSyncCooldownMs: 5 * 60_000,
    continuationProjectionIntervalMs: 2_000,
    continuationProjectionBacklogEvents: 500,
    inlineProjectionMaxRawEvents: 250,
    interactiveAuth: {
      ttlMs: 45_000,
      projectionBatchSize: 25,
      projectionContinueDelayMs: 5_000,
      syncContinueDelayMs: 30_000,
    },
    discordRealtime: {
      enabled: true,
      dmPollMs: 45_000,
    },
    slackRealtime: {
      enabled: false,
      pollMs: undefined as number | undefined,
      userRefreshMs: undefined as number | undefined,
      conversationLimit: undefined as number | undefined,
      messageLimit: undefined as number | undefined,
    },
    whatsappResyncPageBudget: 10,
  },
  telemetry: {
    endpoint: "https://cued.so/api/telemetry/events",
  },
  updater: {
    repo: "Cue-d/cued",
    apiBase: "https://api.github.com",
  },
  contacts: {
    jsonPath: null as string | null,
    configPath: join(CUED_HOME, "contacts.config.json"),
  },
  imessage: {
    chatDbPath: join(homedir(), "Library", "Messages", "chat.db"),
    callHistoryDbPath: join(
      homedir(),
      "Library/Application Support/CallHistoryDB/CallHistory.storedata",
    ),
  },
  gmailSync: {
    pageSize: 50,
    pageBudget: 5,
    fetchConcurrency: 8,
  },
  linkedinSync: {
    connectionPages: 25,
    conversationPages: 50,
    messagePages: 10,
    fetchConcurrency: 3,
  },
  discordSync: {
    messageChannelLimit: 5,
    messagesPerChannelLimit: 50,
    backfillPageLimit: 2,
  },
  slackSync: {
    apiPageBudget: 25,
  },
  slackDesktopImport: {
    appBinary: "/Applications/Slack.app/Contents/MacOS/Slack",
    userDataDir: join(homedir(), "Library", "Application Support", "Slack"),
    remoteDebuggingPort: 9222,
    timeoutMs: 20_000,
  },
  slackHelper: {
    helperBinary: null as string | null,
  },
  whatsappHelper: {
    helperBinary: null as string | null,
  },
  signalCli: {
    repoRoot: REPO_ROOT,
  },
  authRuntime: {
    chromiumAuthTimeoutMs: 15 * 60_000,
    chromiumExecutablePath: resolveChromiumExecutablePath(),
    oauthTimeoutMs: 5 * 60 * 1000,
    fakeAuthResultFile: resolve(CUED_HOME, "auth-test-hooks.json"),
    fakeChromiumAuthResult: null as Record<string, unknown> | null,
    fakeQrNativeAuthResult: null as Record<string, unknown> | null,
  },
};

export const MACOS_APP_CONFIG = CONFIG.macOS;
export const NATIVE_RUNTIME_CONFIG = CONFIG.nativeRuntime;
export const PLATFORM_RUNTIME_CONFIG = CONFIG.platformRuntime;
export const DAEMON_CONFIG = CONFIG.daemon;
export const TELEMETRY_CONFIG = CONFIG.telemetry;
export const UPDATE_RELEASE_CONFIG = CONFIG.updater;
export const CONTACTS_CONFIG = CONFIG.contacts;
export const IMESSAGE_CONFIG = CONFIG.imessage;
export const GMAIL_SYNC_CONFIG = CONFIG.gmailSync;
export const LINKEDIN_SYNC_CONFIG = CONFIG.linkedinSync;
export const DISCORD_SYNC_CONFIG = CONFIG.discordSync;
export const SLACK_SYNC_CONFIG = CONFIG.slackSync;
export const SLACK_DESKTOP_IMPORT_CONFIG = CONFIG.slackDesktopImport;
export const SLACK_HELPER_CONFIG = CONFIG.slackHelper;
export const WHATSAPP_HELPER_CONFIG = CONFIG.whatsappHelper;
export const SIGNAL_CLI_CONFIG = CONFIG.signalCli;
export const AUTH_RUNTIME_CONFIG = CONFIG.authRuntime;

export function getConfiguredContactsJsonPath(): string | null {
  if (CONTACTS_CONFIG.jsonPath) {
    return CONTACTS_CONFIG.jsonPath;
  }
  if (!existsSync(CONTACTS_CONFIG.configPath)) {
    return null;
  }

  const parsed = JSON.parse(readFileSync(CONTACTS_CONFIG.configPath, "utf8")) as {
    jsonPath?: unknown;
  };
  return typeof parsed.jsonPath === "string" && parsed.jsonPath.trim() ? parsed.jsonPath : null;
}

export function readFakeAuthResult(runtime: FakeAuthRuntime): Record<string, unknown> | null {
  const configured =
    runtime === "chromium"
      ? AUTH_RUNTIME_CONFIG.fakeChromiumAuthResult
      : AUTH_RUNTIME_CONFIG.fakeQrNativeAuthResult;
  if (configured) {
    return configured;
  }

  try {
    const parsed = JSON.parse(readFileSync(AUTH_RUNTIME_CONFIG.fakeAuthResultFile, "utf8")) as {
      chromium?: unknown;
      qrNative?: unknown;
    };
    const value = runtime === "chromium" ? parsed.chromium : parsed.qrNative;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function ensureCuedDirs(): void {
  const dirs = [
    CUED_HOME,
    CUED_LOG_DIR,
    CUED_BROWSER_DIR,
    CUED_INTEGRATIONS_DIR,
    CUED_SIGNAL_DIR,
    CUED_WHATSAPP_DIR,
    CUED_ATTACHMENTS_DIR,
    CUED_ATTACHMENTS_OBJECTS_DIR,
    CUED_ATTACHMENTS_TMP_DIR,
    CUED_UPDATES_DIR,
    CUED_UPDATE_DOWNLOADS_DIR,
    CUED_UPDATE_ROLLBACK_DIR,
    CUED_BACKUPS_DIR,
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    chmodSync(dir, 0o700);
  }
}
