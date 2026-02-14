import type { QueuedMessage, SendResult } from "@cued/shared";

type ValidationSuccess<T> = { ok: true; value: T };
type ValidationFailure = { ok: false; result: SendResult };
type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

/**
 * Validate that a queued message contains non-empty text.
 */
export function requireMessageText(
  message: QueuedMessage
): ValidationResult<string> {
  if (!message.text || message.text.trim().length === 0) {
    return {
      ok: false,
      result: {
        success: false,
        error: "Message text is required",
        retryable: false,
      },
    };
  }

  return { ok: true, value: message.text };
}

/**
 * Validate that a queued message includes a thread/conversation ID.
 */
export function requireThreadId(
  message: QueuedMessage,
  platformName: string
): ValidationResult<string> {
  if (!message.threadId) {
    return {
      ok: false,
      result: {
        success: false,
        error: `${platformName} messages require a conversation ID (threadId)`,
        retryable: false,
      },
    };
  }

  return { ok: true, value: message.threadId };
}
