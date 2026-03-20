import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { SlackHelperClient } from "./client.js";

class MockChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinWrites: string[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.stdinWrites.push(chunk.toString());
      callback(null);
    },
  });
}

describe("slack helper client", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("writes credentials and payload to the helper stdin", async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const client = new SlackHelperClient(
      { token: "xoxc-test", cookie: "cookie-test" },
      { helperPath: "/tmp/cued-slack-helper" },
    );

    const promise = client.listConversations("im,mpim", "cursor-a", 50);
    child.stdout.write(
      `${JSON.stringify({
        ok: true,
        protocolVersion: 1,
        result: {
          conversations: [],
          nextCursor: "next-cursor",
        },
      })}\n`,
    );
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      conversations: [],
      nextCursor: "next-cursor",
    });
    expect(JSON.parse(child.stdinWrites[0] ?? "{}")).toEqual({
      credentials: {
        token: "xoxc-test",
        cookie: "cookie-test",
      },
      types: "im,mpim",
      cursor: "cursor-a",
      limit: 50,
    });
  });

  it("surfaces helper envelope errors", async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const client = new SlackHelperClient(
      { token: "xoxc-test", cookie: "cookie-test" },
      { helperPath: "/tmp/cued-slack-helper" },
    );

    const promise = client.testAuth();
    child.stdout.write(
      `${JSON.stringify({
        ok: false,
        protocolVersion: 1,
        error: "bad auth",
      })}\n`,
    );
    child.emit("close", 1);

    await expect(promise).rejects.toThrow("bad auth");
  });

  it("retries transient helper errors and returns the later success", async () => {
    const transientChild = new MockChild();
    const successChild = new MockChild();
    spawnMock.mockReturnValueOnce(transientChild).mockReturnValueOnce(successChild);

    const client = new SlackHelperClient(
      { token: "xoxc-test", cookie: "cookie-test" },
      {
        helperPath: "/tmp/cued-slack-helper",
        retryAttempts: 2,
        retryBaseMs: 0,
      },
    );

    const promise = client.getReplies("C123", "1710000001.000100");

    transientChild.stderr.write(
      'Post "https://slack.com/api/conversations.replies": net/http: TLS handshake timeout',
    );
    transientChild.emit("close", 1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    successChild.stdout.write(
      `${JSON.stringify({
        ok: true,
        protocolVersion: 1,
        result: {
          messages: [],
          hasMore: false,
        },
      })}\n`,
    );
    successChild.emit("close", 0);

    await expect(promise).resolves.toEqual({
      messages: [],
      hasMore: false,
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  }, 10_000);
});
