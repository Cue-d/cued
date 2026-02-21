import { accessSync, constants } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ipcMain, shell } from "electron";
import type {
  ContactsAccessRequestResult,
  MessagesAutomationAccessRequestResult,
  PermissionStatus,
} from "../../shared/electron-api";
import { loadNativeModule } from "../native-module-loader";
import type { NodeMacContacts } from "../platforms/contacts/types";

/** Path to the iMessage database — protected by Full Disk Access */
const CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
const execFileAsync = promisify(execFile);

let contactsModule: NodeMacContacts | null | undefined;

function loadContactsModule(): NodeMacContacts | null {
  if (contactsModule !== undefined) {
    return contactsModule;
  }
  try {
    contactsModule = loadNativeModule<NodeMacContacts>("node-mac-contacts");
    return contactsModule;
  } catch (error) {
    console.warn("[Permissions] node-mac-contacts unavailable:", error);
    contactsModule = null;
    return null;
  }
}

/**
 * Check if Full Disk Access has been granted by attempting to read the iMessage database.
 */
export function checkFullDiskAccess(): boolean {
  try {
    accessSync(CHAT_DB_PATH, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Contacts access has been granted using the native module.
 */
function checkContactsAccess(): boolean {
  const mod = loadContactsModule();
  if (!mod) {
    return false;
  }
  return mod.getAuthStatus() === "Authorized";
}

/**
 * Check if Messages Automation access has been granted.
 * We can verify this by checking if we can execute a simple AppleScript command.
 */
async function checkMessagesAutomationAccess(): Promise<boolean> {
  const script = 'tell application "Messages" to return (count of accounts)';

  try {
    await execFileAsync("osascript", ["-e", script]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAppleScriptAutomationDenied(message)) {
      return false;
    }
    // If it's some other error (e.g., Messages not installed), consider it unavailable
    // but return false for consistency
    return false;
  }
}

function isAppleScriptAutomationDenied(message: string): boolean {
  return message.includes("-1743") || message.includes("Not authorized to send Apple events");
}

async function requestMessagesAutomationAccess(): Promise<MessagesAutomationAccessRequestResult> {
  const script = 'tell application "Messages" to return (count of accounts)';

  try {
    await execFileAsync("osascript", ["-e", script]);
    console.log("[Permissions] Messages automation access granted");
    return "Authorized";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAppleScriptAutomationDenied(message)) {
      console.log("[Permissions] Messages automation access denied");
      return "Denied";
    }
    console.warn("[Permissions] Unable to request Messages automation access:", message);
    return "Unavailable";
  }
}

async function requestContactsAccess(): Promise<ContactsAccessRequestResult> {
  const mod = loadContactsModule();
  if (!mod) {
    console.warn("[Permissions] Cannot request contacts — native module not available");
    return "Unavailable";
  }

  const status = mod.getAuthStatus();
  if (status === "Authorized") {
    console.log("[Permissions] Contacts already authorized");
    return "Authorized";
  }
  if (status === "Denied" || status === "Restricted") {
    console.log("[Permissions] Contacts access denied/restricted — user must grant in System Settings");
    return "Denied";
  }

  // Status is "Not Determined" — trigger the native prompt
  try {
    const result = await mod.requestAccess();
    if (result === "Authorized") {
      console.log("[Permissions] Contacts access granted");
      return "Authorized";
    }
    console.log("[Permissions] Contacts access denied by user");
    return "Denied";
  } catch (error) {
    console.error("[Permissions] Failed to request contacts access:", error);
    return "Denied";
  }
}

/**
 * Request Contacts access on app startup using node-mac-contacts.
 * Calls CNContactStore.requestAccess() from within the Electron main process,
 * which triggers the native macOS permission prompt if status is undetermined.
 */
export async function requestContactsAccessOnStartup(): Promise<void> {
  await requestContactsAccess();
}

/**
 * Register permission-related IPC handlers.
 */
export function setupPermissionIpcHandlers(): void {
  ipcMain.handle("permissions:check", async (): Promise<PermissionStatus> => {
    return {
      fullDiskAccess: checkFullDiskAccess(),
      contacts: checkContactsAccess(),
      messagesAutomation: await checkMessagesAutomationAccess(),
    };
  });

  ipcMain.handle("permissions:openFullDiskAccessSettings", async () => {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    );
  });

  ipcMain.handle("permissions:openContactsSettings", async () => {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts"
    );
  });

  ipcMain.handle("permissions:openAutomationSettings", async () => {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
    );
  });

  ipcMain.handle("permissions:requestContactsAccess", async () => {
    return await requestContactsAccess();
  });

  ipcMain.handle("permissions:requestMessagesAutomationAccess", async () => {
    return await requestMessagesAutomationAccess();
  });
}
