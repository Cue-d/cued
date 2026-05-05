import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveMacOSNativeBinary } from "../../../runtime/native-binary.js";
import { DEFAULT_CHAT_DB_PATH, IMessageReader } from "../../imessage/reader.js";
import { type IntegrationAuthState, parseIntegrationAuthState } from "../types.js";
import type { ManagedIntegrationState } from "./types.js";

export function getContactsAuthState(
  resolveNativeBinary: (
    envVarValue: string | undefined,
  ) => string | null = resolveMacOSNativeBinary,
): IntegrationAuthState {
  const nativeBinary = resolveNativeBinary(process.env.CUED_CONTACTS_NATIVE_BINARY);
  if (!nativeBinary) {
    return "native_helper_missing";
  }
  try {
    const stdout = execFileSync(nativeBinary, ["contacts", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(stdout) as { status?: string };
    return parseIntegrationAuthState(parsed.status);
  } catch {
    return "check_failed";
  }
}

export function getIMessageAuthState(
  resolveNativeBinary: (
    envVarValue: string | undefined,
  ) => string | null = resolveMacOSNativeBinary,
): IntegrationAuthState {
  const chatDbPath = process.env.CUED_IMESSAGE_DB_PATH ?? DEFAULT_CHAT_DB_PATH;
  if (!existsSync(chatDbPath)) {
    return "missing";
  }
  const nativeBinary = resolveNativeBinary(process.env.CUED_IMESSAGE_NATIVE_BINARY);
  if (nativeBinary) {
    try {
      execFileSync(
        nativeBinary,
        ["imessage", "dump", "--db-path", chatDbPath, "--after-rowid", "0", "--limit", "1"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return "authorized";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("authorization denied") ||
        message.includes("unable to open database file")
      ) {
        return "needs_full_disk_access";
      }
      return "blocked";
    }
  }
  try {
    const reader = new IMessageReader(chatDbPath);
    try {
      reader.getMaxMessageRowid();
      return "authorized";
    } finally {
      reader.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("authorization denied") ||
      message.includes("unable to open database file")
    ) {
      return "needs_full_disk_access";
    }
    return "blocked";
  }
}

export function buildLocalIntegrationStates(): ManagedIntegrationState[] {
  const chatDbPath = process.env.CUED_IMESSAGE_DB_PATH ?? DEFAULT_CHAT_DB_PATH;
  const contactsAuthState = getContactsAuthState();
  const imessageAuthState = getIMessageAuthState();
  return [
    {
      platform: "contacts",
      accountKey: "local",
      displayName: "Contacts.app",
      authState: contactsAuthState,
      enabled: true,
      connectionKind: "native",
      runtimeKind: "native",
      syncCapable: contactsAuthState === "authorized",
      launchStrategy: "system-settings",
      launchTarget: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
      importedFrom: "local-system",
    },
    {
      platform: "imessage",
      accountKey: "local",
      displayName: "Messages",
      authState: imessageAuthState,
      enabled: true,
      connectionKind: "native",
      runtimeKind: "native",
      syncCapable: imessageAuthState === "authorized",
      launchStrategy: "system-settings",
      launchTarget: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      importedFrom: "local-system",
      artifactPaths: existsSync(chatDbPath) ? [chatDbPath] : [],
    },
  ];
}
