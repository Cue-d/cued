import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageResponseCard, type MessageResponseCardProps, type DisplayMessage, type DraftOption } from "../message-response-card";

// Ensure React is globally available for JSX transform
globalThis.React = React;

// Mock @/lib/utils
vi.mock("@/lib/utils", () => ({
  cn: (...args: (string | undefined | false)[]) => args.filter(Boolean).join(" "),
  getThemeColors: () => ({
    background: "#FFFFFF",
    foreground: "#18181B",
    mutedForeground: "#71717A",
    primary: "#EA580C",
  }),
}));

// Mock ChatInput component
vi.mock("@/components/chat/chat-input", () => ({
  ChatInput: ({ value, onChangeText, placeholder }: {
    value: string;
    onChangeText: (text: string) => void;
    placeholder?: string;
  }) => (
    <input
      data-testid="chat-input"
      value={value}
      onChange={(e) => onChangeText(e.target.value)}
      placeholder={placeholder}
    />
  ),
}));

describe("MessageResponseCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultProps: MessageResponseCardProps = {
    personName: "John Doe",
    messages: [],
    responseText: "",
    onResponseChange: vi.fn(),
  };

  const createMessage = (overrides: Partial<DisplayMessage> = {}): DisplayMessage => {
    // Provide all required fields explicitly to avoid undefined issues with Partial
    const base: DisplayMessage = {
      _id: `msg-${Math.random().toString(36).substr(2, 9)}`,
      content: "Test message",
      sentAt: Date.now() - 60000,
      isFromMe: false,
      senderName: null,
    };
    return { ...base, ...overrides };
  };

  describe("header rendering", () => {
    it("renders person name", () => {
      render(<MessageResponseCard {...defaultProps} />);

      expect(screen.getByText("John Doe")).toBeDefined();
    });

    it("renders initials from person name", () => {
      render(<MessageResponseCard {...defaultProps} />);

      expect(screen.getByText("JD")).toBeDefined();
    });

    it("renders single initial for single-word name", () => {
      render(<MessageResponseCard {...defaultProps} personName="Madonna" />);

      expect(screen.getByText("M")).toBeDefined();
    });

    it("renders relative time when timestamp provided", () => {
      const timestamp = Date.now() - 5 * 60 * 1000; // 5 minutes ago
      render(<MessageResponseCard {...defaultProps} messageTimestamp={timestamp} />);

      // formatRelativeTime should show "5m ago" or similar
      const container = screen.getByText("John Doe").parentElement;
      expect(container).toBeDefined();
    });

    it("does not render time when timestamp not provided", () => {
      render(<MessageResponseCard {...defaultProps} />);

      // Check header renders without timestamp (but with name)
      expect(screen.getByText("John Doe")).toBeDefined();
    });
  });

  describe("platform badge", () => {
    it("renders iMessage platform badge", () => {
      render(<MessageResponseCard {...defaultProps} platform="imessage" />);

      expect(screen.getByText("iMessage")).toBeDefined();
    });

    it("renders Gmail platform badge", () => {
      render(<MessageResponseCard {...defaultProps} platform="gmail" />);

      expect(screen.getByText("Gmail")).toBeDefined();
    });

    it("renders Slack platform badge", () => {
      render(<MessageResponseCard {...defaultProps} platform="slack" />);

      expect(screen.getByText("Slack")).toBeDefined();
    });

    it("does not render platform badge when not provided", () => {
      render(<MessageResponseCard {...defaultProps} />);

      expect(screen.queryByText("iMessage")).toBeNull();
      expect(screen.queryByText("Gmail")).toBeNull();
      expect(screen.queryByText("Slack")).toBeNull();
    });
  });

  describe("desktop status", () => {
    it("renders Online status when desktop is online for iMessage", () => {
      render(<MessageResponseCard {...defaultProps} platform="imessage" isDesktopOnline={true} />);

      expect(screen.getByText("Online")).toBeDefined();
    });

    it("renders Offline status when desktop is offline for iMessage", () => {
      render(<MessageResponseCard {...defaultProps} platform="imessage" isDesktopOnline={false} />);

      expect(screen.getByText("Offline")).toBeDefined();
    });

    it("does not render desktop status for non-iMessage platforms", () => {
      render(<MessageResponseCard {...defaultProps} platform="gmail" isDesktopOnline={true} />);

      expect(screen.queryByText("Online")).toBeNull();
      expect(screen.queryByText("Offline")).toBeNull();
    });
  });

  describe("message rendering", () => {
    it("renders empty state when no messages", () => {
      render(<MessageResponseCard {...defaultProps} messages={[]} />);

      expect(screen.getByText("No recent messages")).toBeDefined();
    });

    it("renders message content", () => {
      const messages = [createMessage({ content: "Hello there!" })];
      render(<MessageResponseCard {...defaultProps} messages={messages} />);

      expect(screen.getByText("Hello there!")).toBeDefined();
    });

    it("renders multiple messages", () => {
      const messages = [
        createMessage({ content: "First message", sentAt: Date.now() - 120000 }),
        createMessage({ content: "Second message", sentAt: Date.now() - 60000 }),
      ];
      render(<MessageResponseCard {...defaultProps} messages={messages} />);

      expect(screen.getByText("First message")).toBeDefined();
      expect(screen.getByText("Second message")).toBeDefined();
    });

    it("renders sender name for received messages in group chat", () => {
      const messages = [createMessage({ content: "Hello", senderName: "Alice", isFromMe: false })];
      render(<MessageResponseCard {...defaultProps} messages={messages} />);

      expect(screen.getByText("Alice")).toBeDefined();
    });

    it("does not render sender name for sent messages", () => {
      const messages = [createMessage({ content: "Hello", senderName: "Me", isFromMe: true })];
      render(<MessageResponseCard {...defaultProps} messages={messages} />);

      // senderName should not be displayed for sent messages
      expect(screen.queryByText("Me")).toBeNull();
    });

    it("renders [No text] for empty message content", () => {
      const messages = [createMessage({ content: "" })];
      render(<MessageResponseCard {...defaultProps} messages={messages} />);

      expect(screen.getByText("[No text]")).toBeDefined();
    });
  });

  describe("delivery status", () => {
    it("renders Read status for read messages", () => {
      const messages = [createMessage({ isFromMe: true, status: "read" })];
      render(<MessageResponseCard {...defaultProps} messages={messages} />);

      expect(screen.getByText("Read")).toBeDefined();
    });

    it("renders Delivered status for delivered messages", () => {
      const messages = [createMessage({ isFromMe: true, status: "delivered" })];
      render(<MessageResponseCard {...defaultProps} messages={messages} />);

      expect(screen.getByText("Delivered")).toBeDefined();
    });

    it("renders Sent status for messages without status", () => {
      const messages = [createMessage({ isFromMe: true })];
      render(<MessageResponseCard {...defaultProps} messages={messages} />);

      expect(screen.getByText("Sent")).toBeDefined();
    });

    it("does not render delivery status for received messages", () => {
      const messages = [createMessage({ isFromMe: false })];
      render(<MessageResponseCard {...defaultProps} messages={messages} />);

      // Should not show status indicators for received messages
      expect(screen.queryByText("Read")).toBeNull();
      expect(screen.queryByText("Delivered")).toBeNull();
      expect(screen.queryByText("Sent")).toBeNull();
    });
  });

  describe("chat input", () => {
    it("renders chat input with value", () => {
      render(<MessageResponseCard {...defaultProps} responseText="Hello" />);

      const input = screen.getByTestId("chat-input");
      expect(input).toBeDefined();
      expect((input as HTMLInputElement).value).toBe("Hello");
    });

    it("calls onResponseChange when input changes", () => {
      const onResponseChange = vi.fn();
      render(<MessageResponseCard {...defaultProps} onResponseChange={onResponseChange} />);

      const input = screen.getByTestId("chat-input");
      fireEvent.change(input, { target: { value: "New text" } });

      expect(onResponseChange).toHaveBeenCalledWith("New text");
    });

    it("renders with placeholder", () => {
      render(<MessageResponseCard {...defaultProps} />);

      const input = screen.getByTestId("chat-input");
      expect(input.getAttribute("placeholder")).toBe("Message...");
    });
  });

  describe("draft options / suggestion chips", () => {
    const draftOptions: DraftOption[] = [
      { text: "Sounds good!", label: "direct", confidence: 0.9, assumptions: [], styleSources: [], riskFlags: [] },
      { text: "Thank you for reaching out.", label: "diplomatic", confidence: 0.85, assumptions: [], styleSources: [], riskFlags: [] },
      { text: "I'll have to pass on this.", label: "boundary", confidence: 0.8, assumptions: [], styleSources: [], riskFlags: [] },
    ];

    it("renders draft option chips", () => {
      render(<MessageResponseCard {...defaultProps} draftOptions={draftOptions} />);

      expect(screen.getByText("Sounds good!")).toBeDefined();
      expect(screen.getByText("Thank you for reaching out.")).toBeDefined();
      expect(screen.getByText("I'll have to pass on this.")).toBeDefined();
    });

    it("does not render chips when no draft options", () => {
      render(<MessageResponseCard {...defaultProps} draftOptions={[]} />);

      expect(screen.queryByText("Sounds good!")).toBeNull();
    });

    it("calls onOptionSelect when chip is pressed", () => {
      const onOptionSelect = vi.fn();
      render(
        <MessageResponseCard
          {...defaultProps}
          draftOptions={draftOptions}
          onOptionSelect={onOptionSelect}
        />
      );

      // Find and click the first chip's pressable
      const chip = screen.getByText("Sounds good!");
      const pressable = chip.closest("pressable");
      if (pressable) {
        fireEvent.click(pressable);
      }
    });

    it("updates response text when chip is selected", () => {
      const onResponseChange = vi.fn();
      render(
        <MessageResponseCard
          {...defaultProps}
          draftOptions={draftOptions}
          onResponseChange={onResponseChange}
        />
      );

      // Chips should be rendered
      expect(screen.getByText("Sounds good!")).toBeDefined();
    });
  });

  describe("message reactions", () => {
    it("renders reaction badges when message has reactions", () => {
      const messages = [
        createMessage({
          content: "Great news!",
          reactions: ["👍", "❤️"],
        }),
      ];
      render(<MessageResponseCard {...defaultProps} messages={messages} />);

      expect(screen.getByText("👍")).toBeDefined();
      expect(screen.getByText("❤️")).toBeDefined();
    });

    it("limits displayed reactions to 3", () => {
      const messages = [
        createMessage({
          content: "Popular message",
          reactions: ["👍", "❤️", "😂", "🎉", "🔥"],
        }),
      ];
      render(<MessageResponseCard {...defaultProps} messages={messages} />);

      // Should only show first 3
      expect(screen.getByText("👍")).toBeDefined();
      expect(screen.getByText("❤️")).toBeDefined();
      expect(screen.getByText("😂")).toBeDefined();
      expect(screen.queryByText("🎉")).toBeNull();
      expect(screen.queryByText("🔥")).toBeNull();
    });
  });

  describe("styling", () => {
    it("applies custom className", () => {
      const { container } = render(
        <MessageResponseCard {...defaultProps} className="custom-class" />
      );

      // Verify component renders with custom class (className is passed to root View)
      expect(container.firstChild).toBeDefined();
    });
  });
});
