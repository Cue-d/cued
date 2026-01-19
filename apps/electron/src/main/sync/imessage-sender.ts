/**
 * iMessage sender service for Electron.
 * Polls Convex for pending sends and executes via AppleScript.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";
import type { Id } from "@prm/convex";
import { electronEnv } from "@prm/env/electron";

const execAsync = promisify(exec);
const CONVEX_URL = electronEnv.CONVEX_URL;

interface SendResult {
  success: boolean;
  error?: string;
}

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
 * Send an iMessage to a recipient (phone or email).
 * Uses AppleScript to interact with Messages.app.
 */
export async function sendMessage(
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
    const message = error instanceof Error ? error.message : String(error);
    console.error("[iMessage] Send failed:", message);
    return { success: false, error: message };
  }
}

/**
 * Send an iMessage to a group chat.
 * Uses chat identifier to target the specific group.
 */
export async function sendToGroup(
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
    const message = error instanceof Error ? error.message : String(error);
    console.error("[iMessage] Group send failed:", message);
    return { success: false, error: message };
  }
}

// Types for Convex pending send
interface PendingSend {
  _id: Id<"pendingSends">;
  text: string;
  recipientHandle: string;
  isGroup: boolean;
  chatIdentifier?: string;
}

type TokenProvider = () => Promise<string | null>;

/**
 * iMessage sender manager.
 * Polls Convex for pending sends and processes them.
 */
export class IMessageSender {
  private getToken: TokenProvider;
  private client: ConvexHttpClient;
  private pollInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(getToken: TokenProvider) {
    this.getToken = getToken;
    this.client = new ConvexHttpClient(CONVEX_URL);
  }

  /**
   * Start polling for pending sends.
   */
  start(intervalMs = 5000): void {
    if (this.pollInterval) return;

    // Initial poll
    this.processPendingSends();

    // Set up interval
    this.pollInterval = setInterval(() => {
      this.processPendingSends();
    }, intervalMs);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Process all pending sends.
   */
  private async processPendingSends(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Refresh auth token
      const token = await this.getToken();
      if (!token) {
        this.isProcessing = false;
        return;
      }
      this.client.setAuth(token);

      // Get pending sends using typed API
      const { sends } = await this.client.query(api.pendingSends.getPendingSends, {
        limit: 10,
      });

      if (sends.length === 0) {
        this.isProcessing = false;
        return;
      }

      for (const send of sends) {
        await this.processSend(send as PendingSend);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[iMessage] Error processing pending sends:", message);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single pending send.
   */
  private async processSend(send: PendingSend): Promise<void> {
    try {
      // Mark as sending
      await this.client.mutation(api.pendingSends.markSending, {
        sendId: send._id,
      });

      // Send the message
      let result: SendResult;
      if (send.isGroup && send.chatIdentifier) {
        result = await sendToGroup(send.chatIdentifier, send.text);
      } else if (send.recipientHandle) {
        result = await sendMessage(send.recipientHandle, send.text);
      } else {
        result = { success: false, error: "No recipient or chat identifier" };
      }

      // Update status
      if (result.success) {
        await this.client.mutation(api.pendingSends.markSent, {
          sendId: send._id,
        });
      } else {
        await this.client.mutation(api.pendingSends.markFailed, {
          sendId: send._id,
          error: result.error || "Unknown error",
        });
        console.error(`[iMessage] Failed to send: ${result.error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[iMessage] Error processing send ${send._id}:`, message);

      try {
        await this.client.mutation(api.pendingSends.markFailed, {
          sendId: send._id,
          error: message,
        });
      } catch {
        // Ignore secondary error
      }
    }
  }
}

// Singleton instance
let senderInstance: IMessageSender | null = null;

/**
 * Get or create the iMessage sender instance.
 */
export function getIMessageSender(getToken?: TokenProvider): IMessageSender {
  if (!senderInstance && getToken) {
    senderInstance = new IMessageSender(getToken);
  }
  if (!senderInstance) {
    throw new Error("IMessageSender not initialized - provide getToken first");
  }
  return senderInstance;
}
