/**
 * iMessage sender service for Electron.
 * Polls Convex for pending sends and executes via AppleScript.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

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
  _id: string;
  text: string;
  recipientHandle: string;
  isGroup: boolean;
  chatIdentifier?: string;
}

type TokenProvider = () => Promise<string | null>;

interface ConvexClient {
  mutation: <T>(name: string, args: Record<string, unknown>) => Promise<T>;
  query: <T>(name: string, args: Record<string, unknown>) => Promise<T>;
}

/**
 * Create a Convex client for pending sends operations.
 */
function createConvexClient(getToken: TokenProvider): ConvexClient {
  const CONVEX_URL = process.env.VITE_CONVEX_URL || "https://peaceful-tern-595.convex.cloud";

  async function callConvex<T>(
    type: "mutation" | "query",
    name: string,
    args: Record<string, unknown>
  ): Promise<T> {
    const token = await getToken();
    if (!token) {
      throw new Error("No auth token available");
    }

    const response = await fetch(`${CONVEX_URL}/api/${type}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        path: name,
        args,
      }),
    });

    if (!response.ok) {
      throw new Error(`Convex ${type} failed: ${response.statusText}`);
    }

    const result = await response.json();
    return result.value as T;
  }

  return {
    mutation: <T>(name: string, args: Record<string, unknown>) =>
      callConvex<T>("mutation", name, args),
    query: <T>(name: string, args: Record<string, unknown>) =>
      callConvex<T>("query", name, args),
  };
}

/**
 * iMessage sender manager.
 * Polls Convex for pending sends and processes them.
 */
export class IMessageSender {
  private getToken: TokenProvider;
  private pollInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(getToken: TokenProvider) {
    this.getToken = getToken;
  }

  /**
   * Start polling for pending sends.
   */
  start(intervalMs = 5000): void {
    if (this.pollInterval) return;

    console.log("[iMessage] Sender started, polling every", intervalMs, "ms");

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
      console.log("[iMessage] Sender stopped");
    }
  }

  /**
   * Process all pending sends.
   */
  private async processPendingSends(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const client = createConvexClient(this.getToken);

      // Get pending sends
      const { sends } = await client.query<{ sends: PendingSend[] }>(
        "pendingSends:getPendingSends",
        { limit: 10 }
      );

      if (sends.length === 0) {
        this.isProcessing = false;
        return;
      }

      console.log(`[iMessage] Processing ${sends.length} pending send(s)`);

      for (const send of sends) {
        await this.processSend(client, send);
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
  private async processSend(
    client: ConvexClient,
    send: PendingSend
  ): Promise<void> {
    try {
      // Mark as sending
      await client.mutation("pendingSends:markSending", { sendId: send._id });

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
        await client.mutation("pendingSends:markSent", { sendId: send._id });
        console.log(`[iMessage] Sent message to ${send.isGroup ? "group" : send.recipientHandle}`);
      } else {
        await client.mutation("pendingSends:markFailed", {
          sendId: send._id,
          error: result.error || "Unknown error",
        });
        console.log(`[iMessage] Failed to send: ${result.error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[iMessage] Error processing send ${send._id}:`, message);

      try {
        await client.mutation("pendingSends:markFailed", {
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
