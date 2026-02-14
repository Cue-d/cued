/**
 * Twitter adapter for the unified message queue.
 */

import type { PlatformAdapter, QueuedMessage, SendResult } from '@cued/shared'
import { getTwitterSyncManager } from './sync'
import {
  requireMessageText,
  requireThreadId,
} from '../../adapters/validation'
import {
  getErrorMessage,
  isRetryableError,
} from '../../sync/error-utils'

const TWITTER_PERMANENT_ERROR_PATTERNS = [
  'not found',
  'invalid',
  'forbidden',
  'unauthorized',
  '401',
  '403',
] as const

export class TwitterAdapter implements PlatformAdapter {
  readonly platform = 'twitter' as const

  async send(message: QueuedMessage): Promise<SendResult> {
    const textValidation = requireMessageText(message)
    if (!textValidation.ok) return textValidation.result

    const threadIdValidation = requireThreadId(message, 'Twitter')
    if (!threadIdValidation.ok) return threadIdValidation.result

    const syncManager = getTwitterSyncManager()
    const client = syncManager.client

    if (!client) {
      return {
        success: false,
        error: 'Twitter client not configured',
        retryable: true,
      }
    }

    if (!client.isAuthenticated()) {
      return {
        success: false,
        error: 'Not authenticated with Twitter',
        retryable: true,
      }
    }

    try {
      const sent = await client.sendDirectMessage(
        threadIdValidation.value,
        textValidation.value
      )

      if (sent.message) {
        void syncManager.syncSentMessage(sent.message).catch((error) => {
          console.error('[TwitterAdapter] Failed to sync sent message:', error)
        })
      }

      return {
        success: true,
        messageId: sent.message?.message_data.id ?? sent.message?.id,
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      return {
        success: false,
        error: errorMessage,
        retryable: isRetryableError(errorMessage, {
          permanentPatterns: TWITTER_PERMANENT_ERROR_PATTERNS,
        }),
      }
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return getTwitterSyncManager().client?.isAuthenticated() ?? false
  }
}
