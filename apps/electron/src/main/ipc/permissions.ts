import { accessSync, constants } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ipcMain, shell } from "electron";
import type { PermissionStatus } from "../../shared/electron-api";
import { loadNativeModule } from "../native-module-loader";
import type { NodeMacContacts } from "../platforms/contacts/types";

/** Path to the iMessage database — protected by Full Disk Access */
const CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

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
function checkFullDiskAccess(): boolean {
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
 * Request Contacts access on app startup using node-mac-contacts.
 * Calls CNContactStore.requestAccess() from within the Electron main process,
 * which triggers the native macOS permission prompt if status is undetermined.
 */
export async function requestContactsAccessOnStartup(): Promise<void> {
  const mod = loadContactsModule();
  if (!mod) {
    console.warn("[Permissions] Cannot request contacts — native module not available");
    return;
  }

  const status = mod.getAuthStatus();
  if (status === "Authorized" || status === "Limited") {
    console.log("[Permissions] Contacts already authorized");
    return;
  }
  if (status === "Denied" || status === "Not Authorized") {
    console.log("[Permissions] Contacts access denied — user must grant in System Settings");
    return;
  }

  // Status is "Not Determined" — trigger the native prompt
  try {
    const result = await mod.requestAccess();
    if (result === "Authorized") {
      console.log("[Permissions] Contacts access granted");
    } else {
      console.log("[Permissions] Contacts access denied by user");
    }
  } catch (error) {
    console.error("[Permissions] Failed to request contacts access:", error);
  }
}

/**
 * Register permission-related IPC handlers.
 */
export function setupPermissionIpcHandlers(): void {
  ipcMain.handle("permissions:check", async (): Promise<PermissionStatus> => {
    return {
      fullDiskAccess: checkFullDiskAccess(),
      contacts: checkContactsAccess(),
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
}
