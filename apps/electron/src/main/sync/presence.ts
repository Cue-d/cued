/**
 * Presence heartbeat manager for Electron.
 * Sends periodic heartbeats to Convex so mobile can detect if desktop is online.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "@cued/convex";
import { isAuthError } from "../auth/auth-utils";
import { app } from "electron";
import { electronEnv } from "@cued/env/electron";

const CONVEX_URL = electronEnv.CONVEX_URL;
const HEARTBEAT_INTERVAL_MS = 15_000;

type TokenProvider = () => Promise<string | null>;
type ForceRefreshProvider = () => Promise<string | null>;

/**
 * Heartbeat manager for presence tracking.
 */
export class HeartbeatManager {
  private getToken: TokenProvider;
  private forceRefresh: ForceRefreshProvider | null = null;
  private client: ConvexHttpClient;
  private intervalId: NodeJS.Timeout | null = null;
  private isSending = false;

  constructor(getToken: TokenProvider) {
    this.getToken = getToken;
    this.client = new ConvexHttpClient(CONVEX_URL);
  }

  /**
   * Set the force refresh callback for auth error recovery.
   */
  setForceRefreshCallback(callback: ForceRefreshProvider): void {
    this.forceRefresh = callback;
  }


  start(): void {
    if (this.intervalId) return;
    console.log("[Presence] Starting heartbeat");

    this.sendHeartbeat();
    this.intervalId = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    const token = await this.getToken();
    if (!token) return;

    this.client.setAuth(token);
    await this.client.mutation(api.presence.disconnect, {}).catch((error) => {
      console.error("[Presence] Failed to disconnect:", getErrorMessage(error));
    });
    console.log("[Presence] Disconnected from server");
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.isSending) return;
    this.isSending = true;

    try {
      const token = await this.getToken();
      if (!token) return;

      this.client.setAuth(token);
      await this.client.mutation(api.presence.heartbeat, {
        appVersion: app.getVersion(),
      });
    } catch (error) {
      // Try to recover from auth errors
      if (isAuthError(error) && this.forceRefresh) {
        console.log("[Presence] Auth error detected, force refreshing token...");
        try {
          const newToken = await this.forceRefresh();
          if (newToken) {
            this.client.setAuth(newToken);
            await this.client.mutation(api.presence.heartbeat, {
              appVersion: app.getVersion(),
            });
            console.log("[Presence] Heartbeat succeeded after token refresh");
            return;
          }
        } catch (retryError) {
          console.error("[Presence] Heartbeat retry failed:", getErrorMessage(retryError));
        }
      }
      console.error("[Presence] Heartbeat failed:", getErrorMessage(error));
    } finally {
      this.isSending = false;
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Singleton instance
let instance: HeartbeatManager | null = null;

export function getHeartbeatManager(getToken?: TokenProvider): HeartbeatManager {
  if (!instance) {
    if (!getToken) {
      throw new Error("HeartbeatManager not initialized - provide getToken first");
    }
    instance = new HeartbeatManager(getToken);
  }
  return instance;
}
