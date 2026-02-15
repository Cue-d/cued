import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InboxMessageBubble } from "../message-bubble";
import type { InboxMessage } from "../message-types";

const baseMessage: InboxMessage = {
  _id: "msg-1",
  content: "Hello there",
  sentAt: Date.now(),
  isFromMe: false,
  platform: "imessage",
  sender: { _id: "contact-1", displayName: "Alice" },
  reactions: null,
};

describe("InboxMessageBubble", () => {
  it("renders reaction badges and truncates to three emojis", () => {
    render(
      <InboxMessageBubble
        message={{
          ...baseMessage,
          reactions: ["👍", "❤️", "😂", "🎉"],
        }}
      />
    );

    expect(screen.getByText("👍")).toBeInTheDocument();
    expect(screen.getByText("❤️")).toBeInTheDocument();
    expect(screen.getByText("😂")).toBeInTheDocument();
    expect(screen.queryByText("🎉")).not.toBeInTheDocument();
  });

  it("does not render reaction badges when reactions are empty", () => {
    render(
      <InboxMessageBubble
        message={{
          ...baseMessage,
          reactions: [],
        }}
      />
    );

    expect(screen.queryByText("👍")).not.toBeInTheDocument();
  });
});
