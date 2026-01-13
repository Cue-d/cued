/**
 * Sync manager for batched incremental iMessage sync.
 *
 * Handles:
 * - Batching messages to stay under Convex limits (~2500/batch)
 * - Incremental sync using ROWID cursor
 * - Background sync on interval
 * - Progress reporting
 */

import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";
import { ChatDb } from "./chat-db";

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
  useTestMutation?: boolean; // Use syncMessagesTest (no auth) for dev
  authToken?: string; // WorkOS access token for authenticated sync
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

    // Set auth token if provided
    if (options.authToken) {
      this.client.setAuth(options.authToken);
    }
  }

  /**
   * Update the auth token (e.g., after token refresh).
   */
  setAuthToken(token: string): void {
    this.options.authToken = token;
    this.client.setAuth(token);
  }

  /**
   * Start background sync on interval.
   */
  async start(): Promise<void> {
    if (this.intervalId) return;

    console.log("[SyncManager] Starting background sync...");

    if (!this.isInitialized && !this.options.useTestMutation) {
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

        const mutation = this.options.useTestMutation
          ? api.sync.syncMessagesTest
          : api.sync.syncMessages;

        const result = await this.client.mutation(mutation, { batch });
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
