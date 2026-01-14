/**
 * Sync manager for batched incremental iMessage sync.
 *
 * Handles:
 * - Batching messages to stay under Convex limits (~2500/batch)
 * - Incremental sync using ROWID cursor
 * - Background sync on interval
 * - Progress reporting
 * - Attachment upload to Convex storage
 */

import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";
import type { Id } from "@prm/convex";
import type { Message } from "@prm/integrations";
import { ChatDb } from "./chat-db";
import { uploadAttachments } from "./attachment-uploader";
import { getContactsManager } from "./contacts";

/** Attachment with Convex storage IDs (properly typed) */
interface ConvexAttachment {
  filename: string;
  mimeType: string;
  size: number;
  storageId: Id<"_storage">;
  thumbnailStorageId?: Id<"_storage">;
}

// Performance tuning constants
const BATCH_SIZE = 1000; // Reduced to stay under Convex 4096 read limit per mutation
const CONCURRENT_BATCHES = 5; // Increased parallelism to compensate for smaller batches
const SYNC_INTERVAL_MS = 30_000; // 30 seconds
const CONVEX_URL =
  process.env.CONVEX_URL || "https://perceptive-lobster-290.convex.cloud";

// Current sync version - must match CURRENT_SYNC_VERSION in packages/convex/convex/sync.ts
const CURRENT_SYNC_VERSION = 1;

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
  recoveryReason?: string; // Why recovery was triggered
}

export interface SyncState {
  cursor: string;
  lastSyncAt: number | null;
  totalMessagesSynced: number;
  totalContactsSynced: number;
  syncVersion: number;
  isConnected: boolean;
  // Task 2.7c: Contacts sync state
  lastContactsSyncAt: number | null;
}

export interface SyncManagerOptions {
  onProgress?: (progress: SyncProgress) => void;
  getAuthToken?: (forceRefresh?: boolean) => Promise<string | null>; // Token provider that refreshes as needed
  onAuthInvalid?: () => void; // Called when auth fails and cannot be refreshed
  syncAttachments?: boolean; // Enable attachment upload (default: false for faster initial sync)
  syncContacts?: () => Promise<{ contactsCount: number }>; // Contact sync function for recovery
}

export class SyncManager {
  private chatDb: ChatDb | null = null;
  private client: ConvexHttpClient;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isInitialized = false;
  private progress: SyncProgress = {
    status: "idle",
    totalMessagesSynced: 0,
  };
  private options: SyncManagerOptions;
  private cursorPath: string;

  constructor(options: SyncManagerOptions = {}) {
    this.options = options;
    this.client = new ConvexHttpClient(CONVEX_URL);
    this.cursorPath = path.join(app.getPath("userData"), "sync_cursor.json");
  }

  /**
   * Set the token provider function.
   */
  setTokenProvider(getAuthToken: () => Promise<string | null>): void {
    this.options.getAuthToken = getAuthToken;
  }

  /**
   * Set the progress callback.
   */
  setProgressCallback(onProgress: (progress: SyncProgress) => void): void {
    this.options.onProgress = onProgress;
  }

  /**
   * Set the auth invalid callback.
   */
  setAuthInvalidCallback(onAuthInvalid: () => void): void {
    this.options.onAuthInvalid = onAuthInvalid;
  }

  /**
   * Refresh and set the auth token on the client.
   * Returns true if a valid token was set, false otherwise.
   * @param forceRefresh - If true, force a token refresh regardless of expiry
   */
  private async refreshAuth(forceRefresh = false): Promise<boolean> {
    if (!this.options.getAuthToken) {
      console.warn("[SyncManager] No token provider configured");
      return false;
    }

    const token = await this.options.getAuthToken(forceRefresh);
    if (!token) {
      console.warn("[SyncManager] Token provider returned no token");
      return false;
    }

    this.client.setAuth(token);
    return true;
  }

  /**
   * Execute a mutation with 401 retry logic.
   * If the mutation fails with 401 (Unauthenticated), refresh the token and retry once.
   */
  private async executeMutationWithRetry<T>(
    mutationFn: () => Promise<T>
  ): Promise<T> {
    try {
      return await mutationFn();
    } catch (error: unknown) {
      if (!this.isAuthError(error)) {
        throw error;
      }

      console.log("[SyncManager] Got auth error, force refreshing token and retrying...");

      // Force refresh since the server rejected our token
      const hasAuth = await this.refreshAuth(true);
      if (!hasAuth) {
        // Notify that auth is invalid so UI can update
        this.options.onAuthInvalid?.();
        throw new Error("Token refresh failed, cannot retry request");
      }

      console.log("[SyncManager] Token refreshed, retrying mutation...");
      return await mutationFn();
    }
  }

  /**
   * Check if an error is an authentication error (401).
   */
  private isAuthError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      // Convex returns "Unauthenticated" for auth errors
      // WorkOS returns "InvalidAuthHeader" with "Token expired" message
      return (
        message.includes("unauthenticated") ||
        message.includes("401") ||
        message.includes("unauthorized") ||
        message.includes("invalidauthheader") ||
        message.includes("token expired")
      );
    }
    return false;
  }

  /**
   * Start background sync on interval.
   */
  async start(): Promise<void> {
    if (this.intervalId) return;

    console.log("[SyncManager] Starting background sync...");

    if (!this.isInitialized) {
      // Refresh auth before fetching cursor from server
      await this.refreshAuth();
      await this.initializeCursorFromServer();
    }

    this.runSync();
    this.intervalId = setInterval(() => this.runSync(), SYNC_INTERVAL_MS);
  }

  /**
   * Initialize sync state from server, detecting recovery scenarios.
   */
  private async initializeCursorFromServer(): Promise<void> {
    this.isInitialized = true;

    try {
      const syncState = await this.client.query(api.sync.getSyncState, {
        platform: "imessage",
      }) as SyncState | null;

      const localCursor = this.loadCursor();

      // Task 2.7c: Pre-load local contacts count before recovery detection
      await this.preloadLocalContactsCount();

      // Check for recovery scenarios
      const recoveryReason = this.detectRecoveryScenario(syncState);

      if (recoveryReason) {
        console.log(`[SyncManager] Recovery triggered: ${recoveryReason}`);
        this.updateProgress({
          status: "recovery",
          recoveryReason,
        });

        // Reset local cursor to trigger full sync
        this.saveCursor(0);

        // Sync contacts first if available
        if (this.options.syncContacts) {
          try {
            console.log("[SyncManager] Running contacts sync as part of recovery...");
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

      // No recovery needed - use max of server and local cursor
      if (!syncState?.cursor) return;

      const serverCursor = parseInt(syncState.cursor, 10);
      const cursor = Math.max(serverCursor, localCursor);

      if (cursor > 0) {
        this.saveCursor(cursor);
        console.log(
          `[SyncManager] Cursor initialized: ${cursor} (server: ${serverCursor}, local: ${localCursor})`
        );
      }

      // Update progress with server totals
      this.updateProgress({
        totalMessagesSynced: syncState.totalMessagesSynced || 0,
        totalContactsSynced: syncState.totalContactsSynced || 0,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(
        "[SyncManager] Server sync state fetch failed, using local:",
        message
      );
    }
  }

  /**
   * Detect if a recovery (full re-sync) is needed.
   * Returns the reason for recovery, or null if no recovery needed.
   */
  private detectRecoveryScenario(syncState: SyncState | null): string | null {
    const hasLocalCursorFile = fs.existsSync(this.cursorPath);

    // Scenario 1: Fresh install (no local cursor file and no server state)
    if (!hasLocalCursorFile && !syncState) {
      return "Fresh install detected";
    }

    // Scenario 2: Local cache cleared (no local cursor file but server has state)
    if (!hasLocalCursorFile && syncState && parseInt(syncState.cursor, 10) > 0) {
      return "Local cache cleared (server has sync state but no local cursor)";
    }

    // Scenario 3: Schema version mismatch
    if (syncState && syncState.syncVersion !== CURRENT_SYNC_VERSION) {
      return `Schema version mismatch (server: ${syncState.syncVersion}, client: ${CURRENT_SYNC_VERSION})`;
    }

    // Task 2.7c: Scenario 4: Contacts count mismatch >10%
    // This detects bulk additions/deletions in Contacts.app
    if (syncState && syncState.totalContactsSynced > 0) {
      const localContactsCount = this.getLocalContactsCount();
      if (localContactsCount > 0) {
        const serverCount = syncState.totalContactsSynced;
        const difference = Math.abs(localContactsCount - serverCount);
        const threshold = Math.max(serverCount, localContactsCount) * 0.1;
        if (difference > threshold) {
          return `Contacts count mismatch >10% (local: ${localContactsCount}, server: ${serverCount})`;
        }
      }
    }

    return null;
  }

  /**
   * Get local contacts count from ContactsManager cache.
   * Returns 0 if cache is not loaded.
   */
  private getLocalContactsCount(): number {
    try {
      const contactsManager = getContactsManager();
      return contactsManager.getCacheSize();
    } catch {
      return 0;
    }
  }

  /**
   * Pre-load local contacts to ensure cache is populated for recovery detection.
   * Uses cache if available, otherwise fetches fresh from Contacts.app.
   */
  private async preloadLocalContactsCount(): Promise<void> {
    try {
      const contactsManager = getContactsManager();
      // fetchContacts uses cache by default, only fetches if expired
      await contactsManager.fetchContacts(false);
      console.log(`[SyncManager] Local contacts loaded: ${contactsManager.getCacheSize()}`);
    } catch (e) {
      console.warn("[SyncManager] Failed to preload contacts:", e);
    }
  }

  /**
   * Set the contacts sync function for recovery flows.
   */
  setSyncContactsCallback(
    syncContacts: () => Promise<{ contactsCount: number }>
  ): void {
    this.options.syncContacts = syncContacts;
  }

  /**
   * Stop background sync.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.closeChatDb();
    console.log("[SyncManager] Stopped background sync");
  }

  /**
   * Run a single sync cycle with parallel batch uploads for improved performance.
   * Uses CONCURRENT_BATCHES parallel uploads to maximize throughput.
   */
  async runSync(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.updateProgress({ status: "syncing" });

    try {
      // Refresh auth token before each sync cycle
      const hasAuth = await this.refreshAuth();
      if (!hasAuth) {
        this.updateProgress({
          status: "error",
          error: "Not authenticated",
          currentBatch: undefined,
        });
        // Notify that auth is invalid so UI can update
        this.options.onAuthInvalid?.();
        return;
      }

      const chatDb = this.getChatDb();
      const maxRowid = chatDb.getMaxMessageRowid();
      let cursor = this.loadCursor();

      if (cursor === 0) {
        console.log(`[SyncManager] Starting full sync (${maxRowid} messages)`);
      }

      const totalStart = performance.now();
      let totalMessagesSynced = 0;
      let batchNumber = 0;
      const estimatedTotalBatches = Math.ceil((maxRowid - cursor) / BATCH_SIZE);

      while (cursor < maxRowid) {
        // Read multiple batches ahead for parallel processing
        const batchesToProcess: Array<{
          batch: ReturnType<ChatDb["buildSyncBatch"]>;
          batchNum: number;
        }> = [];

        let tempCursor = cursor;
        for (let i = 0; i < CONCURRENT_BATCHES && tempCursor < maxRowid; i++) {
          const batch = chatDb.buildSyncBatch(tempCursor, BATCH_SIZE);
          if (batch.messages.length === 0) break;

          batchNumber++;
          batchesToProcess.push({ batch, batchNum: batchNumber });
          tempCursor = batch.cursor;
        }

        if (batchesToProcess.length === 0) break;

        this.updateProgress({
          currentBatch: {
            messagesInBatch: batchesToProcess.reduce((sum, b) => sum + b.batch.messages.length, 0),
            batchNumber: batchesToProcess[0].batchNum,
            estimatedBatchesRemaining: Math.max(0, estimatedTotalBatches - batchNumber),
          },
        });

        // Process batches in parallel
        const batchStart = performance.now();
        const results = await Promise.all(
          batchesToProcess.map(async ({ batch, batchNum }) => {
            return this.processSingleBatch(batch, batchNum);
          })
        );

        const batchTime = performance.now() - batchStart;
        const batchMsgCount = results.reduce((sum, r) => sum + r.messagesCount, 0);
        const rate = Math.round(batchMsgCount / (batchTime / 1000));

        console.log(
          `[SyncManager] Parallel batches ${batchesToProcess[0].batchNum}-${batchesToProcess[batchesToProcess.length - 1].batchNum}: ${batchMsgCount} msgs (${Math.round(batchTime)}ms, ${rate}/s)`
        );

        // Update cursor to the last successful batch
        const lastBatch = batchesToProcess[batchesToProcess.length - 1];
        cursor = lastBatch.batch.cursor;
        this.saveCursor(cursor);

        totalMessagesSynced += batchMsgCount;
        this.updateProgress({
          lastCursor: cursor,
          totalMessagesSynced: this.progress.totalMessagesSynced + batchMsgCount,
        });
      }

      const totalTime = performance.now() - totalStart;
      const overallRate = Math.round(totalMessagesSynced / (totalTime / 1000));
      console.log(
        `[SyncManager] Sync complete: ${totalMessagesSynced} msgs in ${Math.round(totalTime / 1000)}s (${overallRate}/s overall)`
      );

      // Update server sync metadata
      try {
        await this.executeMutationWithRetry(() =>
          this.client.mutation(api.sync.updateSyncMetadata, {
            platform: "imessage",
            cursor: String(cursor),
            totalMessagesSynced: this.progress.totalMessagesSynced,
            totalContactsSynced: this.progress.totalContactsSynced || 0,
            syncVersion: CURRENT_SYNC_VERSION,
          })
        );
      } catch (e) {
        console.warn("[SyncManager] Failed to update sync metadata:", e);
      }

      this.updateProgress({
        status: "idle",
        lastSyncAt: Date.now(),
        currentBatch: undefined,
        recoveryReason: undefined,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[SyncManager] Sync error:", message);
      this.updateProgress({
        status: "error",
        error: message,
        currentBatch: undefined,
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Process a single batch: upload attachments and sync to Convex.
   * Extracted to enable parallel processing.
   */
  private async processSingleBatch(
    batch: ReturnType<ChatDb["buildSyncBatch"]>,
    batchNum: number
  ): Promise<{ messagesCount: number; chatsCount: number; errors: string[] }> {
    // Upload attachments if explicitly enabled (disabled by default for faster initial sync)
    const uploadedAttachmentMap = new Map<number, ConvexAttachment[]>();
    if (this.options.syncAttachments === true) {
      // Process attachments in parallel for this batch
      const attachmentPromises = batch.messages
        .filter((msg) => msg.attachments?.length)
        .map(async (message) => {
          try {
            const uploaded = await uploadAttachments(this.client, message.attachments!);
            if (uploaded.length > 0) {
              const convexAttachments: ConvexAttachment[] = uploaded.map((att) => ({
                filename: att.filename,
                mimeType: att.mimeType,
                size: att.size,
                storageId: att.storageId as Id<"_storage">,
                thumbnailStorageId: att.thumbnailStorageId
                  ? (att.thumbnailStorageId as Id<"_storage">)
                  : undefined,
              }));
              return { messageId: message.id, attachments: convexAttachments };
            }
          } catch (e) {
            console.warn(`[SyncManager] Batch ${batchNum}: Failed to upload attachments for message ${message.id}:`, e);
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

    // Transform batch for Convex sync, including uploaded attachments
    const syncBatch = {
      ...batch,
      messages: batch.messages.map(
        ({ guid, status, errorCode, attachments: localAttachments, reactions, ...rest }) => {
          const uploadedAtts = uploadedAttachmentMap.get(rest.id);
          return {
            ...rest,
            attachments: uploadedAtts,
          };
        }
      ),
    };

    // Execute mutation with 401 retry logic
    const result = await this.executeMutationWithRetry(
      () => this.client.mutation(api.sync.syncMessages, { batch: syncBatch })
    );

    if (result.errors.length > 0) {
      console.warn(`[SyncManager] Batch ${batchNum} errors:`, result.errors.slice(0, 3));
    }

    return result;
  }

  /**
   * Get current sync progress.
   */
  getProgress(): SyncProgress {
    return { ...this.progress };
  }

  /**
   * Force a full resync by resetting cursor (local only, for testing).
   */
  resetCursor(): void {
    this.saveCursor(0);
    this.updateProgress({ lastCursor: 0, totalMessagesSynced: 0, totalContactsSynced: 0 });
    console.log("[SyncManager] Cursor reset, next sync will be full sync");
  }

  /**
   * Force a full re-sync (messages + contacts) by resetting both local and server state.
   * This is the recommended recovery method for users.
   */
  async forceFullSync(): Promise<void> {
    console.log("[SyncManager] Force full sync triggered");

    // Refresh auth first
    const hasAuth = await this.refreshAuth();
    if (!hasAuth) {
      console.error("[SyncManager] Cannot force sync: not authenticated");
      this.updateProgress({
        status: "error",
        error: "Not authenticated",
      });
      return;
    }

    // Reset server sync state
    try {
      await this.executeMutationWithRetry(() =>
        this.client.mutation(api.sync.resetSyncState, {
          platform: "imessage",
        })
      );
      console.log("[SyncManager] Server sync state reset");
    } catch (e) {
      console.warn("[SyncManager] Failed to reset server sync state:", e);
    }

    // Reset local cursor
    this.saveCursor(0);
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
        console.log("[SyncManager] Running contacts sync as part of force full sync...");
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

    // Now run message sync
    await this.runSync();
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

  private loadCursor(): number {
    try {
      if (fs.existsSync(this.cursorPath)) {
        const data = JSON.parse(fs.readFileSync(this.cursorPath, "utf-8"));
        return data.cursor || 0;
      }
    } catch (e) {
      console.warn("[SyncManager] Failed to load cursor:", e);
    }
    return 0;
  }

  private saveCursor(cursor: number): void {
    try {
      const dir = path.dirname(this.cursorPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.cursorPath,
        JSON.stringify({ cursor, updatedAt: Date.now() })
      );
    } catch (e) {
      console.warn("[SyncManager] Failed to save cursor:", e);
    }
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
