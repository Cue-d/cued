import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiscordApiClient } from "../api/client.js";
import { DiscordApiError } from "../api/client.js";
import { DiscordRealtimeSession } from "./session.js";

describe("discord realtime", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("loads new channel messages from the list endpoint when the last message changes", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    let privateChannelPollCount = 0;

    const session = new DiscordRealtimeSession({
      accountKey: "default",
      credentials: {
        token: "discord-token",
      },
      dmPollIntervalMs: 10,
      onEvent,
      client: {
        async getCurrentUser() {
          return {
            id: "u-self",
            username: "avery",
            global_name: "Avery",
          };
        },
        async listPrivateChannels() {
          privateChannelPollCount += 1;
          return [
            {
              id: "dm-1",
              type: 1,
              recipients: [
                {
                  id: "u-other",
                  username: "jarvis",
                  global_name: "Jarvis",
                },
              ],
              last_message_id: privateChannelPollCount === 1 ? "100" : "102",
            },
          ];
        },
        async listChannelMessages() {
          return [
            {
              id: "102",
              channel_id: "dm-1",
              author: {
                id: "u-other",
                username: "jarvis",
              },
              content: "second",
              timestamp: "2026-04-18T12:00:02.000Z",
            },
            {
              id: "101",
              channel_id: "dm-1",
              author: {
                id: "u-other",
                username: "jarvis",
              },
              content: "first",
              timestamp: "2026-04-18T12:00:01.000Z",
            },
          ];
        },
        async sendMessage() {
          throw new Error("not used");
        },
      } as unknown as DiscordApiClient,
    });

    session.start();
    await vi.waitFor(() => {
      expect(session.getStatus()).toEqual(
        expect.objectContaining({
          state: "connected",
          userId: "u-self",
        }),
      );
    });

    onEvent.mockClear();
    await vi.advanceTimersByTimeAsync(10);

    expect(
      onEvent.mock.calls
        .filter(([, event]) => event.event === "message_upsert")
        .map(([, event]) => event.data.message.id),
    ).toEqual(["101", "102"]);

    session.stop();
  });

  it("marks the session connected after initial DM discovery", async () => {
    vi.useFakeTimers();

    const session = new DiscordRealtimeSession({
      accountKey: "default",
      credentials: {
        token: "discord-token",
      },
      dmPollIntervalMs: 10_000,
      client: {
        async getCurrentUser() {
          return {
            id: "u-self",
            username: "avery",
            global_name: "Avery",
          };
        },
        async listPrivateChannels() {
          return [
            {
              id: "dm-1",
              type: 1,
              recipients: [],
              last_message_id: "100",
            },
          ];
        },
        async listChannelMessages() {
          return [];
        },
        async sendMessage() {
          throw new Error("not used");
        },
      } as unknown as DiscordApiClient,
    });

    session.start();

    await vi.waitFor(() => {
      expect(session.getStatus()).toEqual(
        expect.objectContaining({
          state: "connected",
          userId: "u-self",
        }),
      );
    });

    session.stop();
  });

  it("stops instead of reconnecting when Discord auth is invalidated", async () => {
    const onAuthInvalidated = vi.fn();

    const session = new DiscordRealtimeSession({
      accountKey: "default",
      credentials: {
        token: "discord-token",
      },
      onAuthInvalidated,
      client: {
        async getCurrentUser() {
          throw new DiscordApiError("GET", "/users/@me", 401, '{"message":"401: Unauthorized"}');
        },
        async listPrivateChannels() {
          return [];
        },
        async listChannelMessages() {
          return [];
        },
        async sendMessage() {
          throw new Error("not used");
        },
      } as unknown as DiscordApiClient,
    });

    session.start();

    await vi.waitFor(() => {
      expect(session.getStatus()).toEqual(
        expect.objectContaining({
          state: "stopped",
          lastSessionError: expect.stringContaining("401"),
        }),
      );
    });
    expect(onAuthInvalidated).toHaveBeenCalled();
  });

  it("does not mark bootstrap connected when initial DM discovery invalidates auth", async () => {
    vi.useFakeTimers();
    const onAuthInvalidated = vi.fn();
    const onConnected = vi.fn();
    let privateChannelPollCount = 0;

    const session = new DiscordRealtimeSession({
      accountKey: "default",
      credentials: {
        token: "discord-token",
      },
      dmPollIntervalMs: 10,
      onAuthInvalidated,
      onConnected,
      client: {
        async getCurrentUser() {
          return {
            id: "u-self",
            username: "avery",
            global_name: "Avery",
          };
        },
        async listPrivateChannels() {
          privateChannelPollCount += 1;
          throw new DiscordApiError("GET", "/users/@me/channels", 401, '{"message":"401"}');
        },
        async listChannelMessages() {
          return [];
        },
        async sendMessage() {
          throw new Error("not used");
        },
      } as unknown as DiscordApiClient,
    });

    session.start();

    await vi.waitFor(() => {
      expect(session.getStatus()).toEqual(
        expect.objectContaining({
          state: "stopped",
          lastSessionError: expect.stringContaining("401"),
        }),
      );
    });
    expect(onAuthInvalidated).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(privateChannelPollCount).toBe(1);

    session.stop();
  });

  it("retries after the base delay and resets reconnect attempts after recovery", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    let privateChannelPollCount = 0;
    const session = new DiscordRealtimeSession({
      accountKey: "default",
      credentials: {
        token: "discord-token",
      },
      dmPollIntervalMs: 10,
      reconnectBaseMs: 1_000,
      client: {
        async getCurrentUser() {
          return {
            id: "u-self",
            username: "avery",
            global_name: "Avery",
          };
        },
        async listPrivateChannels() {
          privateChannelPollCount += 1;
          if (privateChannelPollCount === 2) {
            throw new Error("temporary failure");
          }
          return [
            {
              id: "dm-1",
              type: 1,
              recipients: [],
              last_message_id: "100",
            },
          ];
        },
        async listChannelMessages() {
          return [];
        },
        async sendMessage() {
          throw new Error("not used");
        },
      } as unknown as DiscordApiClient,
    });

    session.start();
    await vi.waitFor(() => {
      expect(session.getStatus()).toEqual(
        expect.objectContaining({
          state: "connected",
          reconnectAttempts: 0,
        }),
      );
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(session.getStatus()).toEqual(
      expect.objectContaining({
        state: "degraded",
        reconnectAttempts: 1,
        lastSessionError: "temporary failure",
      }),
    );
    expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(session.getStatus()).toEqual(
        expect.objectContaining({
          state: "connected",
          reconnectAttempts: 0,
          lastSessionError: null,
        }),
      );
    });

    session.stop();
  });
});
