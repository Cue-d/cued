/**
 * Sync manager for batched incremental iMessage sync.
 *
 * Handles:
 * - Batching messages to stay under Convex limits (~1000/batch)
 * - Incremental sync using ROWID cursor stored in cloud (Convex syncCursors table)
 * - Background sync on interval
 * - Progress reporting
 * - Attachment upload to Convex storage
 *
 * Sync strategy: Always sync newest messages first (DESC order).
 * - cursor tracks the highest fully-synced ROWID
 * - When new messages exist (cursor < maxRowid), sync from maxRowid down to cursor
 * - After completing, update cursor to maxRowid
 *
 * Cursor storage: Uses Convex syncCursors table for multi-device support.
 * No local cursor file - app reinstall resumes from cloud cursor.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";
import type { Id } from "@prm/convex";
import { withAuthRetry } from "../auth/auth-utils";
import { electronEnv } from "@prm/env/electron";
import { ChatDb } from "./chat-db";
import { uploadAttachments } from "./attachment-uploader";
import { getContactsManager } from "./contacts";
import { getSyncDebugLogger } from "./sync-debug-logger";
import {
  createConvexClient,
  loadCursor,
  saveCursor,
  createSyncGuard,
  createAuthRetryOptions,
  setConvexAuth,
} from "./shared";
import { getValidAccessToken } from "../auth/auth-manager";

/** Attachment with Convex storage IDs (properly typed) */
interface ConvexAttachment {
  filename: string;
  mimeType: string;
  size: number;
  storageId: Id<"_storage">;
  thumbnailStorageId?: Id<"_storage">;
}

// Performance tuning constants
const BATCH_SIZE = 1000;
const CONCURRENT_BATCHES = 5;
const SYNC_INTERVAL_MS = 30_000;

// Current sync version - must match CURRENT_SYNC_VERSION in packages/convex/convex/sync.ts
const CURRENT_SYNC_VERSION = 1;

/**
 * Simple cursor state: tracks highest fully-synced ROWID.
 */
interface CursorState {
  cursor: number;
  updatedAt: number;
}

export interface SyncProgress {
  status: "idle" | "syncing" | "error" | "recovery";
  lastSyncAt?: number;
  lastCursor?: number;
  totalMessagesSynced: number;
  totalContactsSynced?: number;
  currentBatch?: {
    messagesInBatch: number;
    batchNumber: number;
    estimatedBatchesRemaining: number;
  };
  error?: string;
  recoveryReason?: string;
}

export interface SyncState {
  cursor: string;
  lastSyncAt: number | null;
  totalMessagesSynced: number;
  totalContactsSynced: number;
  syncVersion: number;
  isConnected: boolean;
  lastContactsSyncAt: number | null;
}

export interface SyncManagerOptions {
  onProgress?: (progress: SyncProgress) => void;
  syncAttachments?: boolean;
  syncContacts?: () => Promise<{ contactsCount: number }>;
}

export class SyncManager {
  private chatDb: ChatDb | null = null;
  private client: ConvexHttpClient;
  private intervalId: NodeJS.Timeout | null = null;
  private syncGuard = createSyncGuard();
  private isInitialized = false;
  private progress: SyncProgress = {
    status: "idle",
    totalMessagesSynced: 0,
  };
  private options: SyncManagerOptions;
  private cursorState: CursorState = { cursor: 0, updatedAt: Date.now() };

  constructor(options: SyncManagerOptions = {}) {
    this.options = options;
    this.client = createConvexClient();
  }

  setProgressCallback(onProgress: (progress: SyncProgress) => void): void {
    this.options.onProgress = onProgress;
  }

  private async refreshAuth(): Promise<string | null> {
    const token = await setConvexAuth(this.client);
    if (!token) {
      console.warn("[SyncManager] No auth token available");
    }
    return token;
  }

  async start(): Promise<void> {
    if (this.intervalId) return;

    console.log("[SyncManager] Starting background sync...");

    if (!this.isInitialized) {
      await this.refreshAuth();
      await this.initializeCursorFromServer();
    }

    this.runSync();
    this.intervalId = setInterval(() => this.runSync(), SYNC_INTERVAL_MS);
  }

  /**
   * Initialize sync state from cloud cursor, detecting recovery scenarios.
   */
  private async initializeCursorFromServer(): Promise<void> {
    this.isInitialized = true;

    try {
      const cloudCursor = await loadCursor<CursorState>(this.client, "imessage");

      // @ts-ignore - TS2589: Convex's generated types hit TypeScript's depth limit
      const syncState = (await this.client.query(api.sync.getSyncState, {
        platform: "imessage",
      })) as SyncState | null;

      await this.preloadLocalContactsCount();

      const recoveryReason = this.detectRecoveryScenario(cloudCursor, syncState);
      const logger = getSyncDebugLogger();

      if (recoveryReason) {
        console.log(`[SyncManager] Recovery triggered: ${recoveryReason}`);
        logger.logSyncEvent({
          platform: "imessage",
          event: "sync_start",
          details: { mode: "recovery", reason: recoveryReason },
        });
        this.updateProgress({
          status: "recovery",
          recoveryReason,
        });

        // Reset cursor to 0 for full sync
        await this.saveCursorState({ cursor: 0, updatedAt: Date.now() });

        const chatDb = this.getChatDb();
        const maxRowid = chatDb.getMaxMessageRowid();
        console.log(
          `[SyncManager] Full sync initialized: will fetch ${maxRowid} messages DESC`
        );

        logger.logCursorState("imessage", {
          cursor: 0,
          maxRowid,
          mode: "full",
        });

        // Sync contacts first if available
        if (this.options.syncContacts) {
          try {
            console.log(
              "[SyncManager] Running contacts sync as part of recovery..."
            );
            const contactResult = await this.options.syncContacts();
            console.log(
              `[SyncManager] Recovery contacts sync complete: ${contactResult.contactsCount} contacts`
            );
            this.updateProgress({
              totalContactsSynced: contactResult.contactsCount,
            });
          } catch (e) {
            console.warn("[SyncManager] Recovery contacts sync failed:", e);
          }
        }

        return;
      }

      // No recovery needed - restore cursor from cloud
      if (cloudCursor) {
        this.cursorState = {
          cursor: cloudCursor.cursorData.cursor ?? 0,
          updatedAt: cloudCursor.lastSyncAt ?? Date.now(),
        };
        console.log(
          `[SyncManager] Cursor restored from cloud: ${this.cursorState.cursor}`
        );
      }

      if (syncState) {
        this.updateProgress({
          totalMessagesSynced: syncState.totalMessagesSynced || 0,
          totalContactsSynced: syncState.totalContactsSynced || 0,
        });
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(
        "[SyncManager] Cloud cursor fetch failed, starting fresh:",
        message
      );
      this.cursorState = { cursor: 0, updatedAt: Date.now() };
    }
  }

  /**
   * Detect if a recovery (full re-sync) is needed.
   */
  private detectRecoveryScenario(
    cloudCursor: { cursorData: CursorState; lastSyncAt: number } | null,
    syncState: SyncState | null
  ): string | null {
    if (!cloudCursor) {
      return "Fresh install detected (no cloud cursor)";
    }

    if (syncState && syncState.syncVersion !== CURRENT_SYNC_VERSION) {
      return `Schema version mismatch (server: ${syncState.syncVersion}, client: ${CURRENT_SYNC_VERSION})`;
    }

    // Contacts count mismatch detection for recovery
    const localContactsCount = this.getLocalContactsCount();
    const serverCount = syncState?.totalContactsSynced ?? 0;

    console.log(
      `[SyncManager] Recovery check: local=${localContactsCount}, server=${serverCount}`
    );

    // Skip if server has no contacts yet (initial sync)
    if (serverCount === 0) {
      console.log(
        `[SyncManager] Skipping recovery: serverCount=0 (initial sync)`
      );
      return null;
    }

    // Skip if local has no contacts (can't determine mismatch)
    if (localContactsCount === 0) {
      console.log(
        `[SyncManager] Skipping recovery: localCount=0 (no local contacts)`
      );
      return null;
    }

    // Skip if local has more contacts than server (pending sync, not data loss)
    // This can happen when new contacts are added locally but not yet synced
    if (localContactsCount > serverCount) {
      console.log(
        `[SyncManager] Skipping recovery: local > server (pending sync)`
      );
      return null;
    }

    // Check for significant data loss (server has fewer contacts than expected)
    // Use 15% threshold to account for dedup variance
    const difference = serverCount - localContactsCount;
    const threshold = serverCount * 0.15;
    if (difference > threshold) {
      return `Contacts count mismatch >15% (local: ${localContactsCount}, server: ${serverCount}, diff: ${difference})`;
    }

    return null;
  }

  private getLocalContactsCount(): number {
    try {
      const contactsManager = getContactsManager();
      return contactsManager.getCacheSize();
    } catch {
      return 0;
    }
  }

  private async preloadLocalContactsCount(): Promise<void> {
    try {
      const contactsManager = getContactsManager();
      await contactsManager.fetchContacts(false);
      console.log(
        `[SyncManager] Local contacts loaded: ${contactsManager.getCacheSize()}`
      );
    } catch (e) {
      console.warn("[SyncManager] Failed to preload contacts:", e);
    }
  }

  setSyncContactsCallback(
    syncContacts: () => Promise<{ contactsCount: number }>
  ): void {
    this.options.syncContacts = syncContacts;
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.closeChatDb();
    console.log("[SyncManager] Stopped background sync");
  }

  /**
   * Run a single sync cycle.
   * Always syncs newest messages first (DESC) from maxRowid down to cursor.
   */
  async runSync(): Promise<void> {
    if (!this.syncGuard.tryStart()) return;

    this.updateProgress({ status: "syncing" });

    const syncStartTime = Date.now();
    const logger = getSyncDebugLogger();
    const cursor = this.cursorState.cursor;
    const isFullSync = cursor === 0;
    logger.logSyncStart("imessage", isFullSync ? "full" : "incremental");

    try {
      const token = await this.refreshAuth();
      if (!token) {
        this.updateProgress({
          status: "error",
          error: "Not authenticated",
          currentBatch: undefined,
        });
        logger.logSyncError("imessage", "Not authenticated");
        return;
      }

      const chatDb = this.getChatDb();
      const maxRowid = chatDb.getMaxMessageRowid();

      logger.logCursorState("imessage", {
        cursor,
        maxRowid,
        mode: isFullSync ? "full" : "incremental",
      });

      if (cursor >= maxRowid) {
        this.updateProgress({
          status: "idle",
          lastSyncAt: Date.now(),
          currentBatch: undefined,
        });
        return;
      }

      // Sync from maxRowid down to cursor (DESC order, newest first)
      const messagesSynced = await this.syncDescending(chatDb, cursor, maxRowid);

      // Trigger memory processing if we synced any messages
      if (messagesSynced > 0) {
        this.triggerMemoryProcessing().catch((e) => {
          console.warn(
            "[SyncManager] Memory processing failed (non-blocking):",
            e
          );
        });
      }

      logger.logSyncComplete("imessage", {
        messagesProcessed: this.progress.totalMessagesSynced,
        durationMs: Date.now() - syncStartTime,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[SyncManager] Sync error:", message);
      logger.logSyncError("imessage", message);
      this.updateProgress({
        status: "error",
        error: message,
        currentBatch: undefined,
      });
    } finally {
      this.syncGuard.finish();
    }
  }

  /**
   * Sync messages from maxRowid down to cursor in DESC order.
   * Processes batches in parallel for performance.
   * @returns Total messages synced
   */
  private async syncDescending(
    chatDb: ChatDb,
    cursor: number,
    maxRowid: number
  ): Promise<number> {
    console.log(`[SyncManager] Sync DESC: from ${maxRowid} down to ${cursor}`);

    const totalStart = performance.now();
    const estimatedTotal = maxRowid - cursor;
    const estimatedTotalBatches = Math.ceil(estimatedTotal / BATCH_SIZE);

    let currentUpperBound = maxRowid;
    let totalMessagesSynced = 0;
    let batchNumber = 0;

    while (currentUpperBound > cursor) {
      // Read multiple batches for parallel processing
      const batchesToProcess: Array<{
        batch: ReturnType<typeof chatDb.buildSyncBatchDescending>;
        batchNum: number;
      }> = [];

      let tempUpperBound = currentUpperBound;
      for (let i = 0; i < CONCURRENT_BATCHES && tempUpperBound > cursor; i++) {
        const batch = chatDb.buildSyncBatchDescending(tempUpperBound, cursor, BATCH_SIZE);
        if (batch.messages.length === 0) break;

        batchNumber++;
        batchesToProcess.push({ batch, batchNum: batchNumber });
        tempUpperBound = batch.cursor;
      }

      if (batchesToProcess.length === 0) break;

      this.updateProgress({
        currentBatch: {
          messagesInBatch: batchesToProcess.reduce(
            (sum, b) => sum + b.batch.messages.length,
            0
          ),
          batchNumber: batchesToProcess[0].batchNum,
          estimatedBatchesRemaining: Math.max(
            0,
            estimatedTotalBatches - batchNumber
          ),
        },
      });

      // Process batches in parallel
      const batchStart = performance.now();
      const results = await Promise.all(
        batchesToProcess.map(({ batch, batchNum }) =>
          this.processSingleBatch(batch, batchNum)
        )
      );

      const batchTime = performance.now() - batchStart;
      const batchMsgCount = results.reduce((sum, r) => sum + r.messagesCount, 0);
      const rate = Math.round(batchMsgCount / (batchTime / 1000));

      const firstBatch = batchesToProcess[0].batchNum;
      const lastBatch = batchesToProcess[batchesToProcess.length - 1].batchNum;
      console.log(
        `[SyncManager] DESC batches ${firstBatch}-${lastBatch}: ${batchMsgCount} msgs (${Math.round(batchTime)}ms, ${rate}/s)`
      );

      // Update upper bound to continue from lowest processed ROWID
      currentUpperBound = Math.min(...batchesToProcess.map((b) => b.batch.cursor));

      totalMessagesSynced += batchMsgCount;
      this.updateProgress({
        totalMessagesSynced: this.progress.totalMessagesSynced + batchMsgCount,
      });
    }

    // After completing DESC sync, update cursor to maxRowid
    await this.saveCursorState({ cursor: maxRowid, updatedAt: Date.now() });
    await this.updateServerSyncMetadata(maxRowid);

    const totalTime = performance.now() - totalStart;
    const overallRate =
      totalTime > 0 ? Math.round(totalMessagesSynced / (totalTime / 1000)) : 0;
    console.log(
      `[SyncManager] DESC sync complete: ${totalMessagesSynced} msgs in ${Math.round(totalTime / 1000)}s (${overallRate}/s overall)`
    );

    this.updateProgress({
      status: "idle",
      lastSyncAt: Date.now(),
      lastCursor: maxRowid,
      currentBatch: undefined,
      recoveryReason: undefined,
    });

    return totalMessagesSynced;
  }

  private async updateServerSyncMetadata(cursor: number): Promise<void> {
    try {
      await withAuthRetry(
        () =>
          this.client.mutation(api.sync.updateSyncMetadata, {
            platform: "imessage",
            cursor: String(cursor),
            totalMessagesSynced: this.progress.totalMessagesSynced,
            totalContactsSynced: this.progress.totalContactsSynced || 0,
            syncVersion: CURRENT_SYNC_VERSION,
          }),
        createAuthRetryOptions(this.client)
      );
    } catch (e) {
      console.warn("[SyncManager] Failed to update sync metadata:", e);
    }
  }

  /**
   * Process a single batch: upload attachments and sync to Convex.
   */
  private async processSingleBatch(
    batch: ReturnType<ChatDb["buildSyncBatch"]>,
    batchNum: number
  ): Promise<{ messagesCount: number; chatsCount: number; errors: string[] }> {
    const logger = getSyncDebugLogger();
    const messageRowids = batch.messages.map((m) => m.id);
    const rowidRange =
      messageRowids.length > 0
        ? { min: Math.min(...messageRowids), max: Math.max(...messageRowids) }
        : undefined;

    logger.logBatchDetails("imessage", {
      batchNumber: batchNum,
      direction: "desc",
      cursorBefore: messageRowids.length > 0 ? messageRowids[0] : batch.cursor,
      cursorAfter: batch.cursor,
      messagesInBatch: batch.messages.length,
      chatsInBatch: batch.chats.length,
      rowidRange,
    });

    if (batchNum === 1) {
      logger.logRawBatch("imessage", batchNum, {
        cursor: batch.cursor,
        messages: batch.messages.map((m) => ({
          id: m.id,
          chatId: m.chatId,
          timestamp: m.timestamp,
          text: m.text,
        })),
        chats: batch.chats.map((c) => ({
          id: c.id,
          displayName: c.displayName,
          isGroup: c.isGroup,
        })),
      });
    }

    // Upload attachments if enabled
    const uploadedAttachmentMap = new Map<number, ConvexAttachment[]>();
    if (this.options.syncAttachments === true) {
      const attachmentPromises = batch.messages
        .filter((msg) => msg.attachments?.length)
        .map(async (message) => {
          try {
            const uploaded = await uploadAttachments(
              this.client,
              message.attachments!
            );
            if (uploaded.length > 0) {
              const convexAttachments: ConvexAttachment[] = uploaded.map(
                (att) => ({
                  filename: att.filename,
                  mimeType: att.mimeType,
                  size: att.size,
                  storageId: att.storageId as Id<"_storage">,
                  thumbnailStorageId: att.thumbnailStorageId
                    ? (att.thumbnailStorageId as Id<"_storage">)
                    : undefined,
                })
              );
              return { messageId: message.id, attachments: convexAttachments };
            }
          } catch (e) {
            console.warn(
              `[SyncManager] Batch ${batchNum}: Failed to upload attachments for message ${message.id}:`,
              e
            );
          }
          return null;
        });

      const attachmentResults = await Promise.all(attachmentPromises);
      for (const result of attachmentResults) {
        if (result) {
          uploadedAttachmentMap.set(result.messageId, result.attachments);
        }
      }
    }

    // Transform batch for Convex sync
    const syncBatch = {
      ...batch,
      messages: batch.messages.map(
        ({
          guid,
          status,
          errorCode,
          attachments: localAttachments,
          reactions,
          ...rest
        }) => {
          const uploadedAtts = uploadedAttachmentMap.get(rest.id);
          return {
            ...rest,
            attachments: uploadedAtts,
          };
        }
      ),
    };

    const result = await withAuthRetry(
      () => this.client.mutation(api.sync.syncMessages, { batch: syncBatch }),
      createAuthRetryOptions(this.client)
    );

    if (result.errors.length > 0) {
      console.warn(
        `[SyncManager] Batch ${batchNum} errors:`,
        result.errors.slice(0, 3)
      );
      for (const error of result.errors) {
        logger.logSyncError("imessage", error, { batchNumber: batchNum });
      }
    }

    logger.logBatchComplete("imessage", {
      batchNumber: batchNum,
      messagesProcessed: result.messagesCount,
      messagesFiltered: batch.messages.length - result.messagesCount,
    });

    return result;
  }

  getProgress(): SyncProgress {
    return { ...this.progress };
  }

  /**
   * Force a full resync by resetting cursor.
   */
  async resetCursor(): Promise<void> {
    await this.saveCursorState({ cursor: 0, updatedAt: Date.now() });
    this.updateProgress({
      lastCursor: 0,
      totalMessagesSynced: 0,
      totalContactsSynced: 0,
    });
    const chatDb = this.getChatDb();
    const maxRowid = chatDb.getMaxMessageRowid();
    console.log(
      `[SyncManager] Cursor reset, next sync will be full sync DESC (${maxRowid} messages)`
    );
  }

  /**
   * Force a full re-sync (messages + contacts) by resetting both local and server state.
   */
  async forceFullSync(): Promise<void> {
    console.log("[SyncManager] Force full sync triggered");

    const token = await this.refreshAuth();
    if (!token) {
      console.error("[SyncManager] Cannot force sync: not authenticated");
      this.updateProgress({
        status: "error",
        error: "Not authenticated",
      });
      return;
    }

    // Reset server sync state
    try {
      await withAuthRetry(
        () =>
          this.client.mutation(api.sync.resetSyncState, {
            platform: "imessage",
          }),
        createAuthRetryOptions(this.client)
      );
      console.log("[SyncManager] Server sync state reset");
    } catch (e) {
      console.warn("[SyncManager] Failed to reset server sync state:", e);
    }

    await this.saveCursorState({ cursor: 0, updatedAt: Date.now() });

    const chatDb = this.getChatDb();
    const maxRowid = chatDb.getMaxMessageRowid();
    console.log(
      `[SyncManager] Force full sync: will fetch ${maxRowid} messages DESC`
    );

    this.updateProgress({
      lastCursor: 0,
      totalMessagesSynced: 0,
      totalContactsSynced: 0,
      status: "recovery",
      recoveryReason: "Manual force full sync",
    });

    // Sync contacts first
    if (this.options.syncContacts) {
      try {
        console.log(
          "[SyncManager] Running contacts sync as part of force full sync..."
        );
        const contactResult = await this.options.syncContacts();
        console.log(
          `[SyncManager] Force full sync contacts complete: ${contactResult.contactsCount} contacts`
        );
        this.updateProgress({
          totalContactsSynced: contactResult.contactsCount,
        });
      } catch (e) {
        console.warn("[SyncManager] Force full sync contacts failed:", e);
      }
    }

    await this.runSync();
  }

  private async triggerMemoryProcessing(): Promise<void> {
    const token = await getValidAccessToken();
    if (!token) {
      console.log("[SyncManager] No auth token, skipping memory processing");
      return;
    }

    const baseUrl = electronEnv.API_BASE_URL || "http://localhost:3000";
    try {
      const response = await fetch(`${baseUrl}/api/memories/sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: "imessage" }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.warn(
          `[SyncManager] Memory sync returned ${response.status}: ${text.slice(0, 200)}`
        );
        return;
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        console.warn(
          `[SyncManager] Memory sync returned non-JSON content-type: ${contentType}`
        );
        return;
      }

      const result = await response.json();
      console.log(
        `[SyncManager] Memory processing: ${result.memoriesExtracted ?? 0} memories from ${result.messagesProcessed ?? 0} messages`
      );
    } catch (e) {
      console.warn("[SyncManager] Memory sync request failed:", e);
    }
  }

  private getChatDb(): ChatDb {
    if (!this.chatDb) {
      this.chatDb = new ChatDb();
    }
    return this.chatDb;
  }

  private closeChatDb(): void {
    if (this.chatDb) {
      this.chatDb.close();
      this.chatDb = null;
    }
  }

  private loadCursorState(): CursorState {
    return this.cursorState;
  }

  private async saveCursorState(state: CursorState): Promise<void> {
    this.cursorState = state;
    await saveCursor(this.client, "imessage", state, {
      syncMode: state.cursor === 0 ? "full" : "incremental",
    });
  }

  private updateProgress(update: Partial<SyncProgress>): void {
    this.progress = { ...this.progress, ...update };
    this.options.onProgress?.(this.progress);
  }
}

// Singleton instance
let syncManager: SyncManager | null = null;

export function getSyncManager(options?: SyncManagerOptions): SyncManager {
  if (!syncManager) {
    syncManager = new SyncManager(options);
  }
  return syncManager;
}
