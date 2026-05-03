import { describe, expect, it } from "vitest";
import {
  assertCanonicalNormalizedSchemaForWrite,
  assertCanonicalRawEventPayloadForWrite,
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

  it("accepts explicit canonical schemas", () => {
    const normalized = normalizeStoredRawEventForProjection(
      {
        entityKind: "timeline_event",
        eventKind: "system_message",
        normalizedSchema: "timeline_event.system_message@1",
      },
      {
        sourceEventKey: "event-1",
        sourceConversationKey: "conversation-1",
        eventKind: "system_message",
        eventAt: 1,
      },
    );

    expect(normalized).toMatchObject({
      entityKind: "timeline_event",
      eventKind: "system_message",
      normalizedSchema: "timeline_event.system_message@1",
    });
  });

  it("passes canonical call schemas through unchanged", () => {
    const normalized = normalizeStoredRawEventForProjection(
      {
        entityKind: "call",
        eventKind: "observed",
      },
      {
        sourceCallKey: "call-1",
        sourceConversationKey: "conversation-1",
        provider: "facetime",
        direction: "incoming",
        medium: "video",
        status: "missed",
        startedAt: 1,
      },
    );

    expect(normalized).toMatchObject({
      entityKind: "call",
      eventKind: "observed",
      normalizedSchema: "call.observed@1",
    });
  });

  it("canonicalizes legacy event kinds when normalized schema is missing", () => {
    const normalized = normalizeStoredRawEventForProjection(
      {
        entityKind: "message",
        eventKind: "message_created",
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

  it("upcasts legacy system-message payloads during projection normalization", () => {
    const normalized = normalizeStoredRawEventForProjection(
      {
        entityKind: "message",
        eventKind: "message_observed",
      },
      {
        sourceMessageKey: "message-1",
        sourceConversationKey: "conversation-1",
        sentAt: 1,
        content: "Ava joined",
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
      }),
    });
  });

  it("rejects non-canonical schemas for new writes", () => {
    expect(() => assertCanonicalNormalizedSchemaForWrite("message.created@1")).not.toThrow();
    expect(() => assertCanonicalNormalizedSchemaForWrite("call.observed@1")).not.toThrow();
    expect(() =>
      assertCanonicalNormalizedSchemaForWrite("timeline_event.linkedin_system_message@1"),
    ).toThrowError(
      "New raw events must use canonical normalized schemas. Received 'timeline_event.linkedin_system_message@1'.",
    );
  });

  it("rejects malformed canonical payloads for new writes", () => {
    expect(() =>
      assertCanonicalRawEventPayloadForWrite({
        entityKind: "message",
        eventKind: "created",
        payload: {
          sourceConversationKey: "conversation-1",
        },
      }),
    ).toThrow(
      "Raw event payload for 'message.created@1' must include string field 'sourceMessageKey'.",
    );

    expect(() =>
      assertCanonicalRawEventPayloadForWrite({
        entityKind: "reaction",
        eventKind: "added",
        payload: {
          sourceMessageKey: "message-1",
          emoji: "👍",
        },
      }),
    ).toThrow(
      "Raw event payload for 'reaction.added@1' must include string field 'sourceConversationKey'.",
    );

    expect(() =>
      assertCanonicalRawEventPayloadForWrite({
        entityKind: "call",
        eventKind: "observed",
        payload: {
          sourceCallKey: "call-1",
          startedAt: 1,
        },
      }),
    ).toThrow(
      "Raw event payload for 'call.observed@1' must include string field 'sourceConversationKey'.",
    );
  });

  it("canonicalizes legacy normalized schemas during projection normalization", () => {
    const normalized = normalizeStoredRawEventForProjection(
      {
        entityKind: "message",
        eventKind: "created",
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
});
