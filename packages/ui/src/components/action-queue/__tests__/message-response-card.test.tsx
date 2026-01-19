import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  MessageResponseCard,
  type DisplayMessage,
  type DraftOption,
} from "../message-response-card";

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

  describe("draft options", () => {
    const mockDraftOptions: DraftOption[] = [
      {
        text: "Sure, I'd be happy to help!",
        label: "direct",
        confidence: 0.9,
        assumptions: [],
        styleSources: [],
        riskFlags: [],
      },
      {
        text: "Let me think about it and get back to you.",
        label: "diplomatic",
        confidence: 0.85,
        assumptions: [],
        styleSources: [],
        riskFlags: [],
      },
    ];

    it("renders draft options when provided", () => {
      render(
        <MessageResponseCard
          {...defaultProps}
          draftOptions={mockDraftOptions}
        />
      );

      expect(screen.getByText("Suggested replies")).toBeInTheDocument();
      expect(screen.getByText("Sure, I'd be happy to help!")).toBeInTheDocument();
      expect(
        screen.getByText("Let me think about it and get back to you.")
      ).toBeInTheDocument();
    });

    it("renders draft option labels", () => {
      render(
        <MessageResponseCard
          {...defaultProps}
          draftOptions={mockDraftOptions}
        />
      );

      expect(screen.getByText("Direct")).toBeInTheDocument();
      expect(screen.getByText("Diplomatic")).toBeInTheDocument();
    });

    it("calls onOptionSelect and populates textarea when option clicked", () => {
      const onOptionSelect = vi.fn();
      const onResponseChange = vi.fn();

      render(
        <MessageResponseCard
          {...defaultProps}
          draftOptions={mockDraftOptions}
          onOptionSelect={onOptionSelect}
          onResponseChange={onResponseChange}
        />
      );

      const directButton = screen.getByText("Sure, I'd be happy to help!");
      fireEvent.click(directButton);

      expect(onResponseChange).toHaveBeenCalledWith("Sure, I'd be happy to help!");
      expect(onOptionSelect).toHaveBeenCalledWith(mockDraftOptions[0], 0);
    });

    it("shows risk warning for draft options with risk flags", () => {
      const optionsWithRisk: DraftOption[] = [
        {
          text: "Yes, I'll definitely be there at 3pm.",
          label: "direct",
          confidence: 0.8,
          assumptions: [],
          styleSources: [],
          riskFlags: [{ type: "commitment", trigger: "definitely be there" }],
        },
      ];

      render(
        <MessageResponseCard
          {...defaultProps}
          draftOptions={optionsWithRisk}
        />
      );

      expect(screen.getByText(/commitment/i)).toBeInTheDocument();
      expect(screen.getByText(/"definitely be there"/)).toBeInTheDocument();
    });
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

  describe("risk level warnings", () => {
    it("shows warning for medium risk level", () => {
      render(
        <MessageResponseCard
          {...defaultProps}
          riskLevel="medium"
        />
      );

      expect(
        screen.getByText(/contains commitment or sensitive content/i)
      ).toBeInTheDocument();
    });

    it("shows warning for high risk level", () => {
      render(
        <MessageResponseCard
          {...defaultProps}
          riskLevel="high"
        />
      );

      expect(
        screen.getByText(/review carefully before sending/i)
      ).toBeInTheDocument();
    });

    it("does not show warning for low risk level", () => {
      render(
        <MessageResponseCard
          {...defaultProps}
          riskLevel="low"
        />
      );

      expect(
        screen.queryByText(/contains commitment or sensitive content/i)
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/review carefully before sending/i)
      ).not.toBeInTheDocument();
    });
  });
});
