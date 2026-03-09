import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CuedDatabase } from "../db/database.js";
import { listAdapterPlatforms } from "../adapters/registry.js";
import { DEFAULT_CHAT_DB_PATH, IMessageReader } from "../adapters/imessage/reader.js";
import { resolveMacOSNativeBinary } from "../workers/native-binary.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error" | "unknown";
  summary: string;
  details?: unknown;
  remediation?: string;
}

function tryReadMessagesDatabase(): DoctorCheck {
  if (!existsSync(DEFAULT_CHAT_DB_PATH)) {
    return {
      name: "messages_database",
      status: "error",
      summary: "Messages database was not found",
      details: { path: DEFAULT_CHAT_DB_PATH },
      remediation: "Open Messages once on this Mac, then rerun doctor.",
    };
  }

  try {
    const reader = new IMessageReader(DEFAULT_CHAT_DB_PATH);
    try {
      const maxRowId = reader.getMaxMessageRowid();
      return {
        name: "messages_database",
        status: "ok",
        summary: "Messages database is readable",
        details: {
          path: DEFAULT_CHAT_DB_PATH,
          maxRowId,
        },
      };
    } finally {
      reader.close();
    }
  } catch (error) {
    return {
      name: "messages_database",
      status: "error",
      summary: "Messages database is not readable",
      details: {
        path: DEFAULT_CHAT_DB_PATH,
        error: error instanceof Error ? error.message : String(error),
      },
      remediation:
        "Grant Full Disk Access to the app that runs cued, then restart that app and rerun doctor.",
    };
  }
}

function getContactsPermissionCheck(): DoctorCheck {
  const nativeBinary = resolveMacOSNativeBinary(process.env.CUED_CONTACTS_NATIVE_BINARY);
  if (!nativeBinary) {
    return {
      name: "contacts_permission",
      status: "unknown",
      summary: "Native macOS helper is not built, so Contacts permission could not be checked",
      remediation: "Run `pnpm --dir apps/cued build:native:macos` or `pnpm permissions:macos -- --contacts`.",
    };
  }

  try {
    const stdout = execFileSync(nativeBinary, ["contacts", "status"], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout) as { status?: string };
    const status = parsed.status ?? "unknown";

    if (status === "authorized") {
      return {
        name: "contacts_permission",
        status: "ok",
        summary: "Contacts access is authorized",
        details: { binary: nativeBinary },
      };
    }

    return {
      name: "contacts_permission",
      status: status === "not_determined" ? "warning" : "error",
      summary: `Contacts access is ${status.replaceAll("_", " ")}`,
      details: { binary: nativeBinary },
      remediation: "Run `pnpm permissions:macos -- --contacts` to trigger the prompt.",
    };
  } catch (error) {
    return {
      name: "contacts_permission",
      status: "error",
      summary: "Contacts permission check failed",
      details: {
        binary: nativeBinary,
        error: error instanceof Error ? error.message : String(error),
      },
      remediation: "Run `pnpm permissions:macos -- --contacts` and confirm the macOS prompt.",
    };
  }
}

function getMessagesAutomationCheck(): DoctorCheck {
  try {
    execFileSync(
      "osascript",
      [
        "-e",
        'with timeout of 1 second',
        "-e",
        'tell application "Messages" to count of services',
        "-e",
        "end timeout",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    return {
      name: "messages_automation",
      status: "ok",
      summary: "Apple Events automation access for Messages is available",
    };
  } catch (error) {
    return {
      name: "messages_automation",
      status: "warning",
      summary: "Apple Events automation for Messages is not verified",
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
      remediation: "Run `pnpm permissions:macos -- --messages` to trigger the Automation prompt.",
    };
  }
}

function getLegacyAuthArtifacts(): Record<string, unknown> {
  const cuedHome = join(homedir(), ".cued");
  return {
    authJson: existsSync(join(cuedHome, "auth.json")),
    agentReplicaDb: existsSync(join(cuedHome, "agent-replica.db")),
    contactsCache: existsSync(join(cuedHome, "contacts_cache.json")),
  };
}

export function buildDoctorReport(db: CuedDatabase): Record<string, unknown> {
  const checks: DoctorCheck[] = [];

  if (process.platform === "darwin") {
    checks.push(getContactsPermissionCheck());
    checks.push(tryReadMessagesDatabase());
    checks.push(getMessagesAutomationCheck());
  }

  return {
    daemon: db.getDaemonState(),
    overview: db.getOverview(),
    checkpoints: db.listCheckpointSummary(),
    recentRuns: db.listRecentRuns(),
    migrationsApplied: true,
    registeredAdapters: listAdapterPlatforms(),
    legacyArtifacts: getLegacyAuthArtifacts(),
    permissionBootstrapCommand: "pnpm permissions:macos -- --all",
    checks,
  };
}
