import { describe, expect, it } from "vitest";
import { buildSignalSyncBundle } from "./bundle.js";

describe("signal worker lib", () => {
  it("builds contact, conversation, and message events from signal-cli data", async () => {
    const bundle = await buildSignalSyncBundle({
      accountKey: "default",
      account: "+14155550000",
      sourceCursor: { lastSyncAt: 1_700_000_000_000 },
      client: {
        async listContacts() {
          return [
            {
              number: "+14155550123",
              name: "Ben Ortiz",
            },
          ];
        },
        async listGroups() {
          return [
            {
              groupId: "group-1",
              name: "Founders",
              members: [{ number: "+14155550123" }],
            },
          ];
        },
        async receiveMessages() {
          return [
            {
              messageId: "msg-1",
              threadId: "dm:+14155550123",
              threadType: "dm" as const,
              text: "Hello from Signal",
              sentAt: 1_710_000_000_000,
              isFromMe: false,
              senderHandle: "+14155550123",
              senderName: "Ben Ortiz",
              peerHandle: "+14155550123",
              attachments: [],
            },
          ];
        },
      },
    });

    expect(bundle.sourceAccounts).toEqual([
      { platform: "signal", accountKey: "default", displayName: "Signal" },
    ]);
    expect(bundle.syncMode).toBe("incremental");
    expect(bundle.rawEvents.some((event) => event.entityKind === "contact")).toBe(true);
    expect(bundle.rawEvents.some((event) => event.entityKind === "conversation")).toBe(true);
    expect(bundle.rawEvents.some((event) => event.entityKind === "message")).toBe(true);

    const messageEvent = bundle.rawEvents.find((event) => event.entityKind === "message");
    expect(messageEvent?.payload).toEqual(
      expect.objectContaining({
        sourceConversationKey: "signal:dm:+14155550123",
        senderSourceKey: "signal:+14155550123",
        content: "Hello from Signal",
        service: "signal",
        isFromMe: false,
      }),
    );
  });
});
