/**
 * iMessage adapter for the unified message queue.
 * Implements PlatformAdapter interface using AppleScript to send via Messages.app.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  PlatformAdapter,
  QueuedMessage,
  SendResult,
} from "@cued/shared";
import { requireMessageText } from "../../adapters/validation";
import {
  getErrorMessage,
  isRetryableError,
} from "../../sync/error-utils";
import { getIMessageSyncManager } from "./sync";

const execAsync = promisify(exec);

const IMESSAGE_PERMANENT_ERROR_PATTERNS = [
  "not found",
  "invalid identifier",
  "not registered with imessage",
] as const;

const IMESSAGE_TRANSIENT_ERROR_PATTERNS = [
  "timeout",
  "connection",
  "network",
  "busy",
] as const;

/**
 * Escape a string for safe use in AppleScript.
 */
function escapeAppleScript(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Send an iMessage to an individual recipient (phone or email).
 */
async function sendToIndividual(
  recipient: string,
  message: string
): Promise<SendResult> {
  const escapedRecipient = escapeAppleScript(recipient);
  const escapedMessage = escapeAppleScript(message);

  const script = `
    tell application "Messages"
      set targetService to 1st account whose service type = iMessage
      set targetBuddy to participant "${escapedRecipient}" of targetService
      send "${escapedMessage}" to targetBuddy
    end tell
  `;

  try {
    await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);

    // Trigger immediate sync to fetch our sent message
    getIMessageSyncManager().runSync().catch((err) => {
      console.warn("[IMessageAdapter] Post-send sync failed:", err);
    });

    return { success: true };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("[IMessageAdapter] Send to individual failed:", errorMessage);
    return {
      success: false,
      error: errorMessage,
      retryable: isRetryableError(errorMessage, {
        permanentPatterns: IMESSAGE_PERMANENT_ERROR_PATTERNS,
        transientPatterns: IMESSAGE_TRANSIENT_ERROR_PATTERNS,
      }),
    };
  }
}

/**
 * Send an iMessage to a group chat using chat identifier.
 */
async function sendToGroup(
  chatIdentifier: string,
  message: string
): Promise<SendResult> {
  const escapedChat = escapeAppleScript(chatIdentifier);
  const escapedMessage = escapeAppleScript(message);

  const script = `
    tell application "Messages"
      set targetChat to chat id "${escapedChat}"
      send "${escapedMessage}" to targetChat
    end tell
  `;

  try {
    await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);

    // Trigger immediate sync to fetch our sent message
    getIMessageSyncManager().runSync().catch((err) => {
      console.warn("[IMessageAdapter] Post-send sync failed:", err);
    });

    return { success: true };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("[IMessageAdapter] Send to group failed:", errorMessage);
    return {
      success: false,
      error: errorMessage,
      retryable: isRetryableError(errorMessage, {
        permanentPatterns: IMESSAGE_PERMANENT_ERROR_PATTERNS,
        transientPatterns: IMESSAGE_TRANSIENT_ERROR_PATTERNS,
      }),
    };
  }
}

/**
 * Check if Messages.app is available and iMessage is configured.
 */
async function checkMessagesAvailable(): Promise<boolean> {
  const script = `
    tell application "System Events"
      return exists application process "Messages"
    end tell
  `;

  try {
    const { stdout } = await execAsync(
      `osascript -e '${script.replace(/'/g, "'\\''")}'`
    );
    const processRunning = stdout.trim() === "true";

    // Also verify iMessage service exists
    const checkIMessageScript = `
      tell application "Messages"
        return (count of (accounts whose service type = iMessage)) > 0
      end tell
    `;
    const { stdout: iMessageResult } = await execAsync(
      `osascript -e '${checkIMessageScript.replace(/'/g, "'\\''")}'`
    );
    const hasIMessageAccount = iMessageResult.trim() === "true";
    return processRunning && hasIMessageAccount;
  } catch {
    return false;
  }
}

/**
 * iMessage adapter implementing the PlatformAdapter interface.
 * Routes messages to individual recipients or group chats via AppleScript.
 */
export class IMessageAdapter implements PlatformAdapter {
  readonly platform = "imessage" as const;

  /**
   * Send a message via iMessage.
   * Handles both individual and group messages.
   */
  async send(message: QueuedMessage): Promise<SendResult> {
    const textValidation = requireMessageText(message);
    if (!textValidation.ok) return textValidation.result;

    // Group message via chat identifier (threadId contains chat ID)
    if (message.threadId) {
      return sendToGroup(message.threadId, textValidation.value);
    }

    // Individual message via handle
    if (message.recipientHandle) {
      return sendToIndividual(message.recipientHandle, textValidation.value);
    }

    // No valid target
    return {
      success: false,
      error: "No recipient handle or thread ID provided",
      retryable: false,
    };
  }

  /**
   * Check if iMessage is configured and available.
   */
  async isAuthenticated(): Promise<boolean> {
    return checkMessagesAvailable();
  }
}
