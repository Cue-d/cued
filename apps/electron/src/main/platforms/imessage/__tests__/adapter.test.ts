import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "@cued/shared";
import { IMessageAdapter } from "../adapter";

const mocks = vi.hoisted(() => ({
  buildIMessageSendScript: vi.fn(),
  executeAppleScript: vi.fn(),
  createSecureAttachmentTempFile: vi.fn(),
  runSync: vi.fn(),
}));

vi.mock("../applescript", () => ({
  buildIMessageSendScript: mocks.buildIMessageSendScript,
  executeAppleScript: mocks.executeAppleScript,
}));

vi.mock("../temp-file-manager", () => ({
  createSecureAttachmentTempFile: mocks.createSecureAttachmentTempFile,
}));

vi.mock("../sync", () => ({
  getIMessageSyncManager: () => ({
    runSync: mocks.runSync,
  }),
}));

function makeQueuedMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "queue-1",
    platform: "imessage",
    recipientHandle: "+15555550123",
    text: "hello",
    ...overrides,
  };
}

function preparedAttachment(path: string) {
  return {
    path,
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

describe("IMessageAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildIMessageSendScript.mockReturnValue("generated-script");
    mocks.executeAppleScript.mockResolvedValue("");
    mocks.runSync.mockResolvedValue(undefined);
  });

  it("sends text-only DM messages without preparing attachments", async () => {
    const adapter = new IMessageAdapter();
    const result = await adapter.send(
      makeQueuedMessage({ text: "text only", recipientHandle: "+15551234567" })
    );

    expect(result).toEqual({ success: true });
    expect(mocks.createSecureAttachmentTempFile).not.toHaveBeenCalled();
    expect(mocks.buildIMessageSendScript).toHaveBeenCalledWith({
      target: { kind: "individual", recipient: "+15551234567" },
      text: "text only",
      attachmentPaths: [],
    });
    expect(mocks.executeAppleScript).toHaveBeenCalledWith("generated-script");
    expect(mocks.runSync).toHaveBeenCalledTimes(1);
  });

  it("sends attachment-only DM messages and cleans up temp files", async () => {
    const adapter = new IMessageAdapter();
    const prepared = preparedAttachment("/tmp/cued-secure-1.jpg");
    mocks.createSecureAttachmentTempFile.mockResolvedValue(prepared);

    const result = await adapter.send(
      makeQueuedMessage({
        text: "   ",
        attachments: [{ localPath: "/Users/test/Desktop/photo.jpg" }],
      })
    );

    expect(result).toEqual({ success: true });
    expect(mocks.buildIMessageSendScript).toHaveBeenCalledWith({
      target: { kind: "individual", recipient: "+15555550123" },
      text: undefined,
      attachmentPaths: ["/tmp/cued-secure-1.jpg"],
    });
    expect(prepared.cleanup).toHaveBeenCalledTimes(1);
  });

  it("sends text + attachments to group chats", async () => {
    const adapter = new IMessageAdapter();
    const preparedA = preparedAttachment("/tmp/secure-a.jpg");
    const preparedB = preparedAttachment("/tmp/secure-b.pdf");
    mocks.createSecureAttachmentTempFile
      .mockResolvedValueOnce(preparedA)
      .mockResolvedValueOnce(preparedB);

    const result = await adapter.send(
      makeQueuedMessage({
        text: "with files",
        threadId: "iMessage;-;chat123",
        attachments: [{ localPath: "/Users/test/one.jpg" }, { localPath: "/Users/test/two.pdf" }],
      })
    );

    expect(result).toEqual({ success: true });
    expect(mocks.buildIMessageSendScript).toHaveBeenCalledWith({
      target: { kind: "group", chatIdentifier: "iMessage;-;chat123" },
      text: "with files",
      attachmentPaths: ["/tmp/secure-a.jpg", "/tmp/secure-b.pdf"],
    });
    expect(preparedA.cleanup).toHaveBeenCalledTimes(1);
    expect(preparedB.cleanup).toHaveBeenCalledTimes(1);
  });

  it("returns permanent, non-retryable failure when attachment source is invalid", async () => {
    const adapter = new IMessageAdapter();
    const firstPrepared = preparedAttachment("/tmp/secure-first.jpg");
    mocks.createSecureAttachmentTempFile
      .mockResolvedValueOnce(firstPrepared)
      .mockRejectedValueOnce(new Error("Attachment path must be a regular file"));

    const result = await adapter.send(
      makeQueuedMessage({
        attachments: [{ localPath: "/tmp/one.jpg" }, { localPath: "/tmp/two.jpg" }],
      })
    );

    expect(result).toMatchObject({
      success: false,
      retryable: false,
    });
    expect(firstPrepared.cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.buildIMessageSendScript).not.toHaveBeenCalled();
    expect(mocks.executeAppleScript).not.toHaveBeenCalled();
  });

  it("treats missing attachment localPath as permanent and non-retryable", async () => {
    const adapter = new IMessageAdapter();
    const result = await adapter.send(
      makeQueuedMessage({
        attachments: [{ localPath: "   " }],
      })
    );

    expect(result).toMatchObject({
      success: false,
      retryable: false,
      error: "Attachment localPath is required",
    });
    expect(mocks.buildIMessageSendScript).not.toHaveBeenCalled();
    expect(mocks.executeAppleScript).not.toHaveBeenCalled();
  });

  it("returns retryable failures for transient AppleScript send errors and still cleans up", async () => {
    const adapter = new IMessageAdapter();
    const prepared = preparedAttachment("/tmp/secure-1.jpg");
    mocks.createSecureAttachmentTempFile.mockResolvedValue(prepared);
    mocks.executeAppleScript.mockRejectedValue(
      new Error("timeout waiting for Messages response")
    );

    const result = await adapter.send(
      makeQueuedMessage({
        attachments: [{ localPath: "/tmp/slow-file.mov" }],
      })
    );

    expect(result).toMatchObject({
      success: false,
      retryable: true,
      error: "timeout waiting for Messages response",
    });
    expect(prepared.cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.runSync).not.toHaveBeenCalled();
  });

  it("rejects messages without text and without attachments", async () => {
    const adapter = new IMessageAdapter();
    const result = await adapter.send(makeQueuedMessage({ text: "   " }));

    expect(result).toEqual({
      success: false,
      error: "Message text or attachments are required",
      retryable: false,
    });
  });
});
