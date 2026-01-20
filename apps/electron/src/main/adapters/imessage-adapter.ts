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
} from "@prm/shared";

const execAsync = promisify(exec);

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
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[IMessageAdapter] Send to individual failed:", errorMessage);
    return {
      success: false,
      error: errorMessage,
      retryable: isRetryableError(errorMessage),
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
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[IMessageAdapter] Send to group failed:", errorMessage);
    return {
      success: false,
      error: errorMessage,
      retryable: isRetryableError(errorMessage),
    };
  }
}

/**
 * Determine if an error is retryable (transient) vs permanent.
 */
function isRetryableError(error: string): boolean {
  const lowerError = error.toLowerCase();

  // Permanent errors - don't retry
  if (
    lowerError.includes("not found") ||
    lowerError.includes("invalid identifier") ||
    lowerError.includes("not registered with imessage")
  ) {
    return false;
  }

  // Transient errors - retry
  if (
    lowerError.includes("timeout") ||
    lowerError.includes("connection") ||
    lowerError.includes("network") ||
    lowerError.includes("busy")
  ) {
    return true;
  }

  // Default: assume retryable
  return true;
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
    // Also verify iMessage service exists
    const checkIMessageScript = `
      tell application "Messages"
        return (count of (accounts whose service type = iMessage)) > 0
      end tell
    `;
    const { stdout: iMessageResult } = await execAsync(
      `osascript -e '${checkIMessageScript.replace(/'/g, "'\\''")}'`
    );
    return iMessageResult.trim() === "true";
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
    // Validate message
    if (!message.text) {
      return {
        success: false,
        error: "Message text is required",
        retryable: false,
      };
    }

    // Group message via chat identifier (threadId contains chat ID)
    if (message.threadId) {
      return sendToGroup(message.threadId, message.text);
    }

    // Individual message via handle
    if (message.recipientHandle) {
      return sendToIndividual(message.recipientHandle, message.text);
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
