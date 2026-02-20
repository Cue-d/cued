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
  it("renders grouped reaction badges with emoji", () => {
    render(
      <InboxMessageBubble
        message={{
          ...baseMessage,
          reactions: [
            { emoji: "👍", reactors: [{ displayName: "Bob", isFromMe: false }] },
            { emoji: "❤️", reactors: [{ displayName: "You", isFromMe: true }] },
          ],
        }}
      />
    );

    expect(screen.getByText("👍")).toBeInTheDocument();
    expect(screen.getByText("❤️")).toBeInTheDocument();
    // Initials appear in both badge and hover card
    expect(screen.getAllByText("B").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Y").length).toBeGreaterThanOrEqual(1);
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

  it("parses Slack links and mentions", () => {
    render(
      <InboxMessageBubble
        message={{
          ...baseMessage,
          platform: "slack",
          content:
            "See <https://example.com/path?x=1&amp;y=2|Example &amp; Co> and ping <@U12345|alice>",
        }}
      />
    );

    const link = screen.getByRole("link", { name: "Example & Co" });
    expect(link).toHaveAttribute("href", "https://example.com/path?x=1&y=2");
    expect(screen.getByText("@alice")).toBeInTheDocument();
  });

  it("parses unlabeled Slack links", () => {
    render(
      <InboxMessageBubble
        message={{
          ...baseMessage,
          platform: "slack",
          content: "Docs: <https://example.com/docs/getting-started>",
        }}
      />
    );

    const link = screen.getByRole("link", {
      name: "example.com/docs/getting-started",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://example.com/docs/getting-started"
    );
  });
});
