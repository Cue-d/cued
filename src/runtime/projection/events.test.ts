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
    expect(() =>
      assertCanonicalNormalizedSchemaForWrite("timeline_event.linkedin_system_message@1"),
    ).toThrowError(
      "New raw events must use canonical normalized schemas. Received 'timeline_event.linkedin_system_message@1'.",
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
