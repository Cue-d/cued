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
}

export class SyncManager {
  private chatDb: ChatDb | null = null;
  private client: ConvexHttpClient;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
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
   * Start background sync on interval.
   */
  start(): void {
    if (this.intervalId) return;

    console.log("[SyncManager] Starting background sync...");
    this.runSync(); // Run immediately
    this.intervalId = setInterval(() => this.runSync(), SYNC_INTERVAL_MS);
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
    if (this.isRunning) {
      console.log("[SyncManager] Sync already running, skipping");
      return;
    }

    this.isRunning = true;
    this.updateProgress({ status: "syncing" });
    console.log("[SyncManager] runSync() starting...");

    try {
      console.log("[SyncManager] Getting ChatDb...");
      const chatDb = this.getChatDb();
      console.log("[SyncManager] ChatDb acquired successfully");
      const maxRowid = chatDb.getMaxMessageRowid();
      let cursor = this.loadCursor();

      // If no cursor, start from beginning (full sync)
      if (cursor === 0) {
        console.log(
          `[SyncManager] Starting full sync from beginning (${maxRowid} messages)`
        );
      }

      let batchNumber = 0;
      const estimatedTotalBatches = Math.ceil((maxRowid - cursor) / BATCH_SIZE);

      while (cursor < maxRowid) {
        batchNumber++;
        const batchStart = performance.now();

        // Build batch
        const batch = chatDb.buildSyncBatch(cursor);

        if (batch.messages.length === 0) {
          console.log("[SyncManager] No new messages to sync");
          break;
        }

        // Limit batch size
        if (batch.messages.length > BATCH_SIZE) {
          batch.messages = batch.messages.slice(0, BATCH_SIZE);
          batch.cursor = batch.messages[batch.messages.length - 1].id;
        }

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

        console.log(
          `[SyncManager] Batch ${batchNumber}: ${batch.messages.length} messages (cursor ${cursor} → ${batch.cursor})`
        );

        // Sync to Convex
        const mutation = this.options.useTestMutation
          ? api.sync.syncMessagesTest
          : api.sync.syncMessages;

        const result = await this.client.mutation(mutation, { batch });

        const batchTime = performance.now() - batchStart;
        const rate = Math.round(result.messagesCount / (batchTime / 1000));

        console.log(
          `[SyncManager] Batch ${batchNumber} complete: ${result.messagesCount} msgs, ${result.chatsCount} chats, ${result.errors.length} errors (${Math.round(batchTime)}ms, ${rate} msg/s)`
        );

        if (result.errors.length > 0) {
          console.warn("[SyncManager] Errors:", result.errors.slice(0, 3));
        }

        // Update cursor and progress
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

      console.log("[SyncManager] Sync cycle complete");
    } catch (error: any) {
      console.error("[SyncManager] Sync error:", error.message);
      this.updateProgress({
        status: "error",
        error: error.message,
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
    if (this.chatDb) {
      return this.chatDb;
    }

    console.log("[SyncManager] Creating new ChatDb instance...");
    this.chatDb = new ChatDb();
    console.log("[SyncManager] ChatDb created successfully");
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
