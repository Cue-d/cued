/**
 * Signal adapter for the unified message queue.
 */

import type {
  PlatformAdapter,
  QueuedMessage,
  SendResult,
} from '@cued/shared'
import { getSignalSyncManager } from './sync'
import type { SignalReceivedMessage } from './client'

function isRetryableError(error: string): boolean {
  const lower = error.toLowerCase()

  if (
    lower.includes('invalid') ||
    lower.includes('not found') ||
    lower.includes('unregistered')
  ) {
    return false
  }

  if (
    lower.includes('timeout') ||
    lower.includes('network') ||
    lower.includes('connection') ||
    lower.includes('temporarily')
  ) {
    return true
  }

  return true
}

function resolveTarget(message: QueuedMessage): {
  recipient?: string
  groupId?: string
  threadId: string
  threadType: 'dm' | 'group'
} | null {
  if (message.threadId?.startsWith('group:')) {
    const groupId = message.threadId.slice('group:'.length)
    if (!groupId) return null
    return {
      groupId,
      threadId: message.threadId,
      threadType: 'group',
    }
  }

  const recipient =
    message.recipientHandle ||
    (message.threadId?.startsWith('dm:')
      ? message.threadId.slice('dm:'.length)
      : undefined)

  if (!recipient) {
    return null
  }

  return {
    recipient,
    threadId: message.threadId || `dm:${recipient.toLowerCase()}`,
    threadType: 'dm',
  }
}

export class SignalAdapter implements PlatformAdapter {
  readonly platform = 'signal' as const

  async send(message: QueuedMessage): Promise<SendResult> {
    if (!message.text || message.text.trim().length === 0) {
      return {
        success: false,
        error: 'Message text is required',
        retryable: false,
      }
    }

    const target = resolveTarget(message)
    if (!target) {
      return {
        success: false,
        error: 'Signal message requires a recipient or group threadId',
        retryable: false,
      }
    }

    const manager = getSignalSyncManager()
    const initialized = await manager.initialize()
    if (!initialized) {
      return {
        success: false,
        error: 'Signal is not configured or unavailable',
        retryable: true,
      }
    }

    const client = manager.getClient()
    if (!client) {
      return {
        success: false,
        error: 'Signal client not available',
        retryable: true,
      }
    }

    try {
      const result = await client.sendMessage(message.text, {
        recipient: target.recipient,
        groupId: target.groupId,
      })

      const sentMessage: SignalReceivedMessage = {
        messageId: `sent:${result.timestamp}:${target.threadId}`,
        threadId: target.threadId,
        threadType: target.threadType,
        text: message.text,
        sentAt: result.timestamp,
        isFromMe: true,
        peerHandle: target.recipient,
      }

      manager.syncSentMessage(sentMessage).catch((error) => {
        console.warn('[SignalAdapter] Post-send sync failed:', error)
      })

      return {
        success: true,
        messageId: sentMessage.messageId,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[SignalAdapter] Send failed:', errorMessage)
      return {
        success: false,
        error: errorMessage,
        retryable: isRetryableError(errorMessage),
      }
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      return await getSignalSyncManager().initialize()
    } catch {
      return false
    }
  }
}

