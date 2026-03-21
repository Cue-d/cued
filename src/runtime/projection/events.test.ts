import { describe, expect, it } from "vitest";
import {
  assertCanonicalNormalizedSchemaForWrite,
  normalizeStoredRawEventForProjection,
} from "./events.js";

describe("normalized raw event registry", () => {
  it("passes canonical schemas through unchanged", () => {
    const normalized = normalizeStoredRawEventForProjection(
      {
        entityKind: "message",
        eventKind: "created",
      },
      {
        sourceMessageKey: "message-1",
        sourceConversationKey: "conversation-1",
        senderSourceKey: "contact-1",
        sentAt: 1,
        content: "hello",
      },
    );

    expect(normalized).toMatchObject({
      entityKind: "message",
      eventKind: "created",
      normalizedSchema: "message.created@1",
    });
  });

  it("upcasts legacy aliases onto canonical schemas", () => {
    const normalized = normalizeStoredRawEventForProjection(
      {
        entityKind: "message",
        eventKind: "message_created",
        normalizedSchema: "message.message_created@1",
      },
      {
        sourceMessageKey: "message-1",
        sourceConversationKey: "conversation-1",
        senderSourceKey: "contact-1",
        sentAt: 1,
        content: "hello",
      },
    );

    expect(normalized).toMatchObject({
      entityKind: "message",
      eventKind: "created",
      normalizedSchema: "message.created@1",
    });
  });

  it("maps legacy message-observed rows onto timeline system messages", () => {
    const normalized = normalizeStoredRawEventForProjection(
      {
        entityKind: "message",
        eventKind: "message_observed",
        normalizedSchema: "message.message_observed@1",
      },
      {
        sourceMessageKey: "message-1",
        sourceConversationKey: "conversation-1",
        sentAt: 1,
        content: "Ava renamed the conversation",
      },
    );

    expect(normalized).toMatchObject({
      entityKind: "timeline_event",
      eventKind: "system_message",
      normalizedSchema: "timeline_event.system_message@1",
      payload: expect.objectContaining({
        sourceEventKey: "message-1",
        sourceConversationKey: "conversation-1",
        eventKind: "system_message",
        eventAt: 1,
        text: "Ava renamed the conversation",
      }),
    });
  });

  it("maps legacy reaction aliases onto canonical add/remove events", () => {
    const added = normalizeStoredRawEventForProjection(
      {
        entityKind: "reaction",
        eventKind: "created",
        normalizedSchema: "reaction.created@1",
      },
      {
        sourceMessageKey: "message-1",
        sourceConversationKey: "conversation-1",
        reactorSourceKey: "contact-1",
        emoji: "👍",
        timestamp: 1,
        isActive: true,
      },
    );
    const removed = normalizeStoredRawEventForProjection(
      {
        entityKind: "reaction",
        eventKind: "created",
        normalizedSchema: "reaction.created@1",
      },
      {
        sourceMessageKey: "message-1",
        sourceConversationKey: "conversation-1",
        reactorSourceKey: "contact-1",
        emoji: "👍",
        timestamp: 2,
        isActive: false,
      },
    );

    expect(added).toMatchObject({
      entityKind: "reaction",
      eventKind: "added",
      normalizedSchema: "reaction.added@1",
    });
    expect(removed).toMatchObject({
      entityKind: "reaction",
      eventKind: "removed",
      normalizedSchema: "reaction.removed@1",
    });
  });

  it("rejects provider-specific schemas for new writes", () => {
    expect(() => assertCanonicalNormalizedSchemaForWrite("message.created@1")).not.toThrow();
    expect(() =>
      assertCanonicalNormalizedSchemaForWrite("timeline_event.linkedin_system_message@1"),
    ).toThrowError(
      "New raw events must use canonical normalized schemas. Received 'timeline_event.linkedin_system_message@1'.",
    );
  });
});
