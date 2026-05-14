import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailMessage } from "../api/client.js";
import { buildGmailSyncBundle } from "./bundle.js";
import { buildGmailRawEvents } from "./events.js";

const gmailClientMock = vi.hoisted(() => ({
  getProfile: vi.fn(),
  listHistory: vi.fn(),
  listMessages: vi.fn(),
  getMessage: vi.fn(),
}));

vi.mock("../api/client.js", () => ({
  GmailClient: {
    fromKeychain: vi.fn(() => gmailClientMock),
  },
}));

function gmailMessage(input: {
  id: string;
  threadId: string;
  from: string;
  to?: string;
  cc?: string;
  subject?: string;
  internalDate?: string;
  payload?: GmailMessage["payload"];
}): GmailMessage {
  return {
    id: input.id,
    threadId: input.threadId,
    internalDate: input.internalDate ?? "1700000000000",
    payload: input.payload ?? {
      headers: [
        { name: "From", value: input.from },
        { name: "To", value: input.to ?? "Me <me@example.com>" },
        ...(input.cc ? [{ name: "Cc", value: input.cc }] : []),
        { name: "Subject", value: input.subject ?? "Project" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from("hello").toString("base64url") },
    },
  };
}

describe("Gmail sync bundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gmailClientMock.getProfile.mockResolvedValue({
      emailAddress: "me@example.com",
      historyId: "history-2",
      messagesTotal: 2,
      threadsTotal: 1,
    });
  });

  it("fetches Gmail history after historical sync completes", async () => {
    gmailClientMock.listHistory.mockResolvedValue({
      historyId: "history-2",
      history: [
        {
          messagesAdded: [{ message: { id: "m-new", threadId: "t-1" } }],
        },
      ],
    });
    gmailClientMock.getMessage.mockResolvedValue(
      gmailMessage({
        id: "m-new",
        threadId: "t-1",
        from: "Friend <friend@example.com>",
      }),
    );

    const bundle = await buildGmailSyncBundle({
      accountKey: "me@example.com",
      sourceCursor: {
        phase: "incremental",
        historicalSyncComplete: true,
        historyId: "history-1",
      },
    });

    expect(gmailClientMock.listHistory).toHaveBeenCalledWith({
      startHistoryId: "history-1",
      pageToken: null,
      maxResults: 50,
    });
    expect(gmailClientMock.listMessages).not.toHaveBeenCalled();
    expect(bundle.syncMode).toBe("incremental");
    expect(bundle.rawEvents.some((event) => event.entityKind === "message")).toBe(true);
    expect(bundle.sourceCursor).toEqual(
      expect.objectContaining({
        historyId: "history-2",
        phase: "incremental",
        historicalSyncComplete: true,
      }),
    );
  });

  it("marks unfinished historical pages with account pagination continuation", async () => {
    gmailClientMock.listMessages.mockResolvedValue({
      messages: [{ id: "m-1", threadId: "t-1" }],
      nextPageToken: "next-page",
    });
    gmailClientMock.getMessage.mockResolvedValue(
      gmailMessage({
        id: "m-1",
        threadId: "t-1",
        from: "Friend <friend@example.com>",
      }),
    );

    const bundle = await buildGmailSyncBundle({
      accountKey: "me@example.com",
      pageBudget: 1,
    });

    expect(bundle.hasMore).toBe(true);
    expect(bundle.continuation).toEqual({
      reason: "account_pagination",
      detail: "Gmail historical message page token remains",
    });
    expect(bundle.proofs?.[0]).toEqual(
      expect.objectContaining({
        proofKind: "messages",
        status: "running",
      }),
    );
  });

  it("merges participants across messages in the same Gmail thread", () => {
    const rawEvents = buildGmailRawEvents({
      accountKey: "me@example.com",
      emailAddress: "me@example.com",
      observedAt: 1700000000000,
      messages: [
        gmailMessage({
          id: "m-1",
          threadId: "t-1",
          from: "Alice <alice@example.com>",
          to: "Me <me@example.com>",
        }),
        gmailMessage({
          id: "m-2",
          threadId: "t-1",
          from: "Me <me@example.com>",
          to: "Bob <bob@example.com>",
        }),
      ],
    });

    const conversations = rawEvents.filter((event) => event.entityKind === "conversation");
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.payload).toEqual(
      expect.objectContaining({
        conversationType: "group",
        participants: expect.arrayContaining([
          { sourceEntityKey: "gmail:alice@example.com", isSelf: false },
          { sourceEntityKey: "gmail:bob@example.com", isSelf: false },
          { sourceEntityKey: "gmail:me@example.com", isSelf: true },
        ]),
      }),
    );
  });

  it("projects Gmail attachment metadata with provider fetch coordinates", () => {
    const rawEvents = buildGmailRawEvents({
      accountKey: "me@example.com",
      emailAddress: "me@example.com",
      observedAt: 1700000000000,
      messages: [
        gmailMessage({
          id: "m-attachment",
          threadId: "t-1",
          from: "Alice <alice@example.com>",
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "From", value: "Alice <alice@example.com>" },
              { name: "To", value: "Me <me@example.com>" },
              { name: "Subject", value: "Spec" },
            ],
            parts: [
              {
                partId: "0",
                mimeType: "text/plain",
                body: { data: Buffer.from("see attached").toString("base64url") },
              },
              {
                partId: "1",
                mimeType: "application/pdf",
                filename: "spec.pdf",
                body: { attachmentId: "att-1", size: 1234 },
              },
            ],
          },
        }),
      ],
    });

    const message = rawEvents.find((event) => event.entityKind === "message");
    expect(message?.payload).toEqual(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            sourceAttachmentKey: "gmail:m-attachment:attachment:att-1",
            filename: "spec.pdf",
            mime_type: "application/pdf",
            access_kind: "provider_fetch",
            access_ref: { messageId: "m-attachment", attachmentId: "att-1" },
            availability_status: "available",
          }),
        ],
      }),
    );
  });
});
