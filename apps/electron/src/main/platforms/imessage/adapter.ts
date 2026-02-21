/**
 * iMessage adapter for the unified message queue.
 * Implements PlatformAdapter interface using AppleScript to send via Messages.app.
 */
import type {
  PlatformAdapter,
  QueuedMessage,
  SendResult,
} from "@cued/shared";
import {
  getErrorMessage,
  isRetryableError,
} from "../../sync/error-utils";
import {
  buildIMessageSendScript,
  executeAppleScript,
  type IMessageScriptTarget,
} from "./applescript";
import {
  createSecureAttachmentTempFile,
  type PreparedAttachmentFile,
} from "./temp-file-manager";
import { getIMessageSyncManager } from "./sync";

const IMESSAGE_PERMANENT_ERROR_PATTERNS = [
  "not found",
  "invalid identifier",
  "not registered with imessage",
  "localpath is required",
  "enoent",
  "no such file",
  "attachment path must be a regular file",
] as const;

const IMESSAGE_TRANSIENT_ERROR_PATTERNS = [
  "timeout",
  "connection",
  "network",
  "busy",
] as const;

function normalizeMessageText(text: string): string | undefined {
  if (text.trim().length === 0) return undefined;
  return text;
}

function triggerPostSendSync(): void {
  getIMessageSyncManager().runSync().catch((err) => {
    console.warn("[IMessageAdapter] Post-send sync failed:", err);
  });
}

async function cleanupPreparedAttachments(
  files: PreparedAttachmentFile[]
): Promise<void> {
  if (files.length === 0) return;

  const results = await Promise.allSettled(files.map((file) => file.cleanup()));
  const rejectedCount = results.filter((result) => result.status === "rejected").length;
  if (rejectedCount > 0) {
    console.warn("[IMessageAdapter] Attachment cleanup had failures", {
      attempted: files.length,
      rejectedCount,
    });
  }
}

async function prepareAttachmentFiles(
  attachments: QueuedMessage["attachments"]
): Promise<PreparedAttachmentFile[]> {
  const prepared: PreparedAttachmentFile[] = [];
  const attachmentList = attachments ?? [];

  try {
    for (const attachment of attachmentList) {
      const localPath = attachment.localPath?.trim();
      if (!localPath) {
        throw new Error("Attachment localPath is required");
      }

      prepared.push(await createSecureAttachmentTempFile(localPath));
    }

    return prepared;
  } catch (error) {
    await cleanupPreparedAttachments(prepared);
    throw error;
  }
}

async function sendToTarget(
  target: IMessageScriptTarget,
  text: string | undefined,
  attachments: QueuedMessage["attachments"]
): Promise<SendResult> {
  let preparedAttachments: PreparedAttachmentFile[] = [];

  try {
    preparedAttachments = await prepareAttachmentFiles(attachments);

    const script = buildIMessageSendScript({
      target,
      text,
      attachmentPaths: preparedAttachments.map((attachment) => attachment.path),
    });

    await executeAppleScript(script);
    triggerPostSendSync();

    return { success: true };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("[IMessageAdapter] Send failed:", errorMessage);

    return {
      success: false,
      error: errorMessage,
      retryable: isRetryableError(errorMessage, {
        permanentPatterns: IMESSAGE_PERMANENT_ERROR_PATTERNS,
        transientPatterns: IMESSAGE_TRANSIENT_ERROR_PATTERNS,
      }),
    };
  } finally {
    await cleanupPreparedAttachments(preparedAttachments);
  }
}

/**
 * Send an iMessage to an individual recipient (phone or email).
 */
async function sendToIndividual(
  recipient: string,
  text: string | undefined,
  attachments: QueuedMessage["attachments"]
): Promise<SendResult> {
  return sendToTarget({ kind: "individual", recipient }, text, attachments);
}

/**
 * Send an iMessage to a group chat using chat identifier.
 */
async function sendToGroup(
  chatIdentifier: string,
  text: string | undefined,
  attachments: QueuedMessage["attachments"]
): Promise<SendResult> {
  return sendToTarget({ kind: "group", chatIdentifier }, text, attachments);
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
    const processRunning = (await executeAppleScript(script)) === "true";

    // Also verify iMessage service exists
    const checkIMessageScript = `
      tell application "Messages"
        return (count of (accounts whose service type = iMessage)) > 0
      end tell
    `;
    const hasIMessageAccount =
      (await executeAppleScript(checkIMessageScript)) === "true";

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
    const text = normalizeMessageText(message.text);
    const hasAttachments = (message.attachments?.length ?? 0) > 0;

    if (!text && !hasAttachments) {
      return {
        success: false,
        error: "Message text or attachments are required",
        retryable: false,
      };
    }

    // Group message via chat identifier (threadId contains chat ID)
    if (message.threadId) {
      return sendToGroup(message.threadId, text, message.attachments);
    }

    // Individual message via handle
    if (message.recipientHandle) {
      return sendToIndividual(message.recipientHandle, text, message.attachments);
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
