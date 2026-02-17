import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageCard } from "../message-card";
import type { ActionCardProps } from "../../types";

const baseProps: ActionCardProps = {
  action: {
    _id: "action-1",
    type: "respond",
    status: "pending",
    priority: 1,
    reason: null,
    llmReason: null,
    createdAt: Date.now(),
    snoozedUntil: null,
    completedAt: null,
    discardedAt: null,
    conversationId: "conv-1",
    contactId: "contact-1",
    contactName: "Alice",
    secondaryContactId: null,
    secondaryContactName: null,
    mergeSuggestionId: null,
    mergeConfidence: null,
    mergeSource: null,
    mergeReasoning: null,
    platform: "slack",
  },
  isTop: true,
  context: {
    action: {
      _id: "action-1",
      type: "respond",
      status: "pending",
      priority: 1,
      reason: null,
      llmReason: null,
      createdAt: Date.now(),
      snoozedUntil: null,
      completedAt: null,
      discardedAt: null,
      platform: "slack",
      secondaryContactId: null,
      mergeSuggestionId: null,
    },
    conversation: {
      _id: "conv-1",
      platform: "slack",
      platformConversationId: "C123",
      conversationType: "channel",
      displayName: "General",
      lastMessageAt: Date.now(),
      workspaceId: "T123",
    },
    contact: {
      _id: "contact-1",
      displayName: "Alice",
      company: null,
      notes: null,
      importance: null,
      handles: [],
    },
    secondaryContact: null,
    participants: [],
    messages: [
      {
        _id: "msg-1",
        content: "See <https://example.com|Example>",
        sentAt: Date.now(),
        isFromMe: false,
        senderName: "Alice",
        senderContactId: "contact-1",
        status: null,
        reactions: ["👍", "🎉"],
      },
    ],
  },
  responseText: "",
  onResponseChange: vi.fn(),
  autoFocus: false,
};

describe("MessageCard", () => {
  it("preserves reactions when context messages use string[] reactions", () => {
    render(<MessageCard {...baseProps} />);

    expect(screen.getByText("👍")).toBeInTheDocument();
    expect(screen.getByText("🎉")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Example" })).toBeInTheDocument();
  });

  it("preserves reactions across rerenders when reactions change shape during pagination", () => {
    const firstContext: NonNullable<ActionCardProps["context"]> = {
      ...baseProps.context!,
      messages: [
        {
          _id: "msg-shared",
          content: "Message with reaction",
          sentAt: Date.now(),
          isFromMe: false,
          senderName: "Alice",
          senderContactId: "contact-1",
          status: null,
          reactions: [{ emoji: "👍" }],
        },
      ],
    };

    const { rerender } = render(
      <MessageCard
        {...baseProps}
        context={firstContext}
      />
    );

    expect(screen.getByText("👍")).toBeInTheDocument();

    const secondContext: NonNullable<ActionCardProps["context"]> = {
      ...firstContext,
      messages: [
        {
          ...firstContext.messages[0],
          reactions: ["👍"],
        },
      ],
    };

    rerender(
      <MessageCard
        {...baseProps}
        context={secondContext}
      />
    );

    expect(screen.getByText("👍")).toBeInTheDocument();
  });
});
