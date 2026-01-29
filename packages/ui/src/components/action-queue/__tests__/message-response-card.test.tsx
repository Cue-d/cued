import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { type DisplayMessage } from "@prm/shared";
import { MessageResponseCard } from "../message-response-card";

describe("MessageResponseCard", () => {
  const mockMessages: DisplayMessage[] = [
    {
      _id: "msg1",
      content: "Hey, how are you?",
      isFromMe: false,
      sentAt: Date.now() - 3600000, // 1 hour ago
      senderName: "John Doe",
    },
    {
      _id: "msg2",
      content: "I'm doing great, thanks!",
      isFromMe: true,
      sentAt: Date.now() - 1800000, // 30 min ago
      senderName: null,
      status: "delivered",
    },
  ];

  const defaultProps = {
    personName: "John Doe",
    messages: mockMessages,
    responseText: "",
    onResponseChange: vi.fn(),
  };

  it("renders person name in header", () => {
    render(<MessageResponseCard {...defaultProps} />);
    // Use heading role to specifically find the header, not sender name in messages
    expect(screen.getByRole("heading", { name: "John Doe" })).toBeInTheDocument();
  });

  it("renders initials in avatar", () => {
    render(<MessageResponseCard {...defaultProps} />);
    expect(screen.getByText("JD")).toBeInTheDocument();
  });

  it("renders all messages", () => {
    render(<MessageResponseCard {...defaultProps} />);
    expect(screen.getByText("Hey, how are you?")).toBeInTheDocument();
    expect(screen.getByText("I'm doing great, thanks!")).toBeInTheDocument();
  });

  it("renders delivery status for sent messages", () => {
    render(<MessageResponseCard {...defaultProps} />);
    expect(screen.getByText("Delivered")).toBeInTheDocument();
  });

  it("calls onResponseChange when typing in textarea", () => {
    const onResponseChange = vi.fn();
    render(
      <MessageResponseCard {...defaultProps} onResponseChange={onResponseChange} />
    );

    const textarea = screen.getByPlaceholderText(/type your response/i);
    fireEvent.change(textarea, { target: { value: "Hello!" } });

    expect(onResponseChange).toHaveBeenCalledWith("Hello!");
  });

  it("displays response text in textarea", () => {
    render(<MessageResponseCard {...defaultProps} responseText="My response" />);

    const textarea = screen.getByPlaceholderText(/type your response/i);
    expect(textarea).toHaveValue("My response");
  });

  it("shows empty state when no messages", () => {
    render(<MessageResponseCard {...defaultProps} messages={[]} />);
    expect(screen.getByText("No recent messages")).toBeInTheDocument();
  });

  describe("platform selector", () => {
    it("renders platform badge when platform provided", () => {
      render(
        <MessageResponseCard
          {...defaultProps}
          platform="imessage"
        />
      );

      expect(screen.getByText("iMessage")).toBeInTheDocument();
    });

    it("renders platform dropdown when multiple platforms available", () => {
      render(
        <MessageResponseCard
          {...defaultProps}
          platform="imessage"
          availablePlatforms={["imessage", "gmail"]}
          onPlatformChange={vi.fn()}
        />
      );

      // Should show current platform with dropdown trigger
      expect(screen.getByText("iMessage")).toBeInTheDocument();
    });
  });

});
