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

  it("rejects non-canonical schemas for new writes", () => {
    expect(() => assertCanonicalNormalizedSchemaForWrite("message.created@1")).not.toThrow();
    expect(() =>
      assertCanonicalNormalizedSchemaForWrite("timeline_event.linkedin_system_message@1"),
    ).toThrowError(
      "New raw events must use canonical normalized schemas. Received 'timeline_event.linkedin_system_message@1'.",
    );
  });

  it("rejects non-canonical schemas during projection normalization", () => {
    expect(() =>
      normalizeStoredRawEventForProjection(
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
      ),
    ).toThrowError(
      "New raw events must use canonical normalized schemas. Received 'message.message_created@1'.",
    );
  });
});
