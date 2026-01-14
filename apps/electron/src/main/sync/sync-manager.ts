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

/** Attachment with Convex storage IDs (properly typed) */
interface ConvexAttachment {
  filename: string;
  mimeType: string;
  size: number;
  storageId: Id<"_storage">;
  thumbnailStorageId?: Id<"_storage">;
}

const BATCH_SIZE = 2500;
const SYNC_INTERVAL_MS = 30_000; // 30 seconds
const CONVEX_URL =
  process.env.CONVEX_URL || "https://perceptive-lobster-290.convex.cloud";

export interface SyncProgress {
  status: "idle" | "syncing" | "error";
  lastSyncAt?: number;
  lastCursor?: number;
  totalMessagesSynced: number;
  currentBatch?: {
    messagesInBatch: number;
    batchNumber: number;
    estimatedBatchesRemaining: number;
  };
  error?: string;
}

export interface SyncManagerOptions {
  onProgress?: (progress: SyncProgress) => void;
  getAuthToken?: (forceRefresh?: boolean) => Promise<string | null>; // Token provider that refreshes as needed
  onAuthInvalid?: () => void; // Called when auth fails and cannot be refreshed
  syncAttachments?: boolean; // Enable attachment upload (default: true)
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
   * Initialize cursor from server, falling back to local if unavailable.
   */
  private async initializeCursorFromServer(): Promise<void> {
    this.isInitialized = true;

    try {
      const result = await this.client.query(api.sync.getSyncCursor, {
        platform: "imessage",
      });

      if (!result?.cursor) return;

      const serverCursor = parseInt(result.cursor, 10);
      const localCursor = this.loadCursor();
      const cursor = Math.max(serverCursor, localCursor);

      if (cursor > 0) {
        this.saveCursor(cursor);
        console.log(
          `[SyncManager] Cursor initialized: ${cursor} (server: ${serverCursor}, local: ${localCursor})`
        );
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(
        "[SyncManager] Server cursor fetch failed, using local:",
        message
      );
    }
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
   * Run a single sync cycle.
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

      let batchNumber = 0;
      const estimatedTotalBatches = Math.ceil((maxRowid - cursor) / BATCH_SIZE);

      while (cursor < maxRowid) {
        batchNumber++;
        const batchStart = performance.now();
        const batch = chatDb.buildSyncBatch(cursor, BATCH_SIZE);

        if (batch.messages.length === 0) break;

        this.updateProgress({
          currentBatch: {
            messagesInBatch: batch.messages.length,
            batchNumber,
            estimatedBatchesRemaining: Math.max(
              0,
              estimatedTotalBatches - batchNumber
            ),
          },
        });

        // Upload attachments if enabled
        const uploadedAttachmentMap = new Map<number, ConvexAttachment[]>();
        if (this.options.syncAttachments !== false) {
          for (const message of batch.messages) {
            if (!message.attachments?.length) continue;

            try {
              const uploaded = await uploadAttachments(this.client, message.attachments);
              if (uploaded.length === 0) continue;

              const convexAttachments: ConvexAttachment[] = uploaded.map((att) => ({
                filename: att.filename,
                mimeType: att.mimeType,
                size: att.size,
                storageId: att.storageId as Id<"_storage">,
                thumbnailStorageId: att.thumbnailStorageId
                  ? (att.thumbnailStorageId as Id<"_storage">)
                  : undefined,
              }));
              uploadedAttachmentMap.set(message.id, convexAttachments);
              console.log(
                `[SyncManager] Uploaded ${uploaded.length} attachments for message ${message.id}`
              );
            } catch (e) {
              console.warn(`[SyncManager] Failed to upload attachments for message ${message.id}:`, e);
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

        const batchTime = performance.now() - batchStart;
        const rate = Math.round(result.messagesCount / (batchTime / 1000));

        console.log(
          `[SyncManager] Batch ${batchNumber}: ${result.messagesCount} msgs, ${result.chatsCount} chats (${Math.round(batchTime)}ms, ${rate}/s)`
        );

        if (result.errors.length > 0) {
          console.warn("[SyncManager] Errors:", result.errors.slice(0, 3));
        }

        cursor = batch.cursor;
        this.saveCursor(cursor);
        this.updateProgress({
          lastCursor: cursor,
          totalMessagesSynced:
            this.progress.totalMessagesSynced + result.messagesCount,
        });
      }

      this.updateProgress({
        status: "idle",
        lastSyncAt: Date.now(),
        currentBatch: undefined,
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
   * Get current sync progress.
   */
  getProgress(): SyncProgress {
    return { ...this.progress };
  }

  /**
   * Force a full resync by resetting cursor.
   */
  resetCursor(): void {
    this.saveCursor(0);
    this.updateProgress({ lastCursor: 0, totalMessagesSynced: 0 });
    console.log("[SyncManager] Cursor reset, next sync will be full sync");
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
