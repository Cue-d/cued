import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ChatMessage,
  type MessageWithToolInvocations,
  type ToolInvocation,
} from "../chat-message";

// Mock the loader component
vi.mock("../../ai-elements/loader", () => ({
  Loader: ({ size }: { size?: number }) => (
    <span data-testid="loader" data-size={size}>Loading...</span>
  ),
}));

// Mock the ToolArtifact component
vi.mock("../tool-artifact", () => ({
  ToolArtifact: ({
    toolName,
    result,
  }: {
    toolName: string;
    result: unknown;
  }) => (
    <div data-testid="tool-artifact" data-tool={toolName}>
      {JSON.stringify(result)}
    </div>
  ),
}));

// Mock Streamdown component used by MessageResponse
vi.mock("streamdown", () => ({
  Streamdown: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="streamdown" className={className}>{children}</div>
  ),
}));

// Mock the Collapsible components
vi.mock("../../ui/collapsible", () => ({
  Collapsible: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div data-testid="collapsible" data-open={open}>
      {children}
    </div>
  ),
  CollapsibleTrigger: ({
    children,
    className,
    onClick,
  }: {
    children: React.ReactNode;
    className?: string;
    onClick?: () => void;
  }) => (
    <button data-testid="collapsible-trigger" className={className} onClick={onClick}>
      {children}
    </button>
  ),
  CollapsibleContent: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="collapsible-content" className={className}>
      {children}
    </div>
  ),
}));

describe("ChatMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("user messages", () => {
    const userMessage: MessageWithToolInvocations = {
      id: "msg-1",
      role: "user",
      content: "Hello, how are you?",
    };

    it("renders user message content", () => {
      render(<ChatMessage message={userMessage} />);
      expect(screen.getByText("Hello, how are you?")).toBeInTheDocument();
    });

    it("renders user avatar icon", () => {
      render(<ChatMessage message={userMessage} />);
      // User avatar has different styling than assistant
      const message = screen.getByText("Hello, how are you?");
      expect(message).toBeInTheDocument();
    });

    it("renders user message with flex-row-reverse layout", () => {
      const { container } = render(<ChatMessage message={userMessage} />);
      // User messages should be on the right side with flex-row-reverse
      const messageWrapper = container.querySelector(".flex-row-reverse");
      expect(messageWrapper).toBeInTheDocument();
    });
  });

  describe("assistant messages", () => {
    const assistantMessage: MessageWithToolInvocations = {
      id: "msg-2",
      role: "assistant",
      content: "I'm doing well, thank you for asking!",
    };

    it("renders assistant message content", () => {
      render(<ChatMessage message={assistantMessage} />);
      expect(screen.getByText("I'm doing well, thank you for asking!")).toBeInTheDocument();
    });

    it("renders assistant message through MessageResponse (Streamdown)", () => {
      render(<ChatMessage message={assistantMessage} />);
      expect(screen.getByTestId("streamdown")).toBeInTheDocument();
    });

    it("renders assistant message with flex-row layout", () => {
      const { container } = render(<ChatMessage message={assistantMessage} />);
      // Assistant messages should be on the left side with flex-row
      const messageWrapper = container.querySelector(".flex-row");
      expect(messageWrapper).toBeInTheDocument();
    });
  });

  describe("streaming state", () => {
    it("shows streaming indicator when isStreaming is true and content is empty", () => {
      const message: MessageWithToolInvocations = {
        id: "msg-3",
        role: "assistant",
        content: "",
      };

      render(<ChatMessage message={message} isStreaming={true} />);
      expect(screen.getByTestId("loader")).toBeInTheDocument();
    });

    it("does not show streaming indicator when content exists", () => {
      const message: MessageWithToolInvocations = {
        id: "msg-3",
        role: "assistant",
        content: "Some content",
      };

      render(<ChatMessage message={message} isStreaming={true} />);
      expect(screen.queryByTestId("loader")).not.toBeInTheDocument();
    });
  });

  describe("tool invocations", () => {
    describe("pending tool calls", () => {
      it("shows tool call indicator for pending calls", () => {
        const message: MessageWithToolInvocations = {
          id: "msg-4",
          role: "assistant",
          content: "",
          toolInvocations: [
            {
              toolCallId: "call-1",
              toolName: "search_messages",
              args: { query: "test" },
              state: "call",
            },
          ],
        };

        render(<ChatMessage message={message} />);
        expect(screen.getByText(/Using search messages.../i)).toBeInTheDocument();
        // Should show loader for pending call
        expect(screen.getByTestId("loader")).toBeInTheDocument();
      });

      it("formats tool name by replacing underscores with spaces", () => {
        const message: MessageWithToolInvocations = {
          id: "msg-5",
          role: "assistant",
          content: "",
          toolInvocations: [
            {
              toolCallId: "call-1",
              toolName: "search_contacts",
              args: {},
              state: "call",
            },
          ],
        };

        render(<ChatMessage message={message} />);
        expect(screen.getByText(/Using search contacts.../i)).toBeInTheDocument();
      });

      it("shows multiple pending tool calls", () => {
        const message: MessageWithToolInvocations = {
          id: "msg-6",
          role: "assistant",
          content: "",
          toolInvocations: [
            {
              toolCallId: "call-1",
              toolName: "search_messages",
              args: {},
              state: "call",
            },
            {
              toolCallId: "call-2",
              toolName: "search_contacts",
              args: {},
              state: "partial-call",
            },
          ],
        };

        render(<ChatMessage message={message} />);
        expect(screen.getByText(/Using search messages.../i)).toBeInTheDocument();
        expect(screen.getByText(/Using search contacts.../i)).toBeInTheDocument();
      });
    });

    describe("completed tool calls", () => {
      it("renders ToolArtifact for single completed call", () => {
        const toolInvocation: ToolInvocation = {
          toolCallId: "call-1",
          toolName: "search_messages",
          args: { query: "test" },
          state: "result",
          result: { results: [{ content: "test message" }] },
        };

        const message: MessageWithToolInvocations = {
          id: "msg-7",
          role: "assistant",
          content: "Here are the search results:",
          toolInvocations: [toolInvocation],
        };

        render(<ChatMessage message={message} />);
        expect(screen.getByTestId("tool-artifact")).toBeInTheDocument();
        expect(screen.getByTestId("tool-artifact")).toHaveAttribute(
          "data-tool",
          "search_messages"
        );
      });

      it("renders collapsible for multiple completed calls", () => {
        const message: MessageWithToolInvocations = {
          id: "msg-8",
          role: "assistant",
          content: "Found results from multiple sources:",
          toolInvocations: [
            {
              toolCallId: "call-1",
              toolName: "search_messages",
              args: {},
              state: "result",
              result: { results: [] },
            },
            {
              toolCallId: "call-2",
              toolName: "search_contacts",
              args: {},
              state: "result",
              result: { results: [] },
            },
          ],
        };

        render(<ChatMessage message={message} />);
        expect(screen.getByTestId("collapsible")).toBeInTheDocument();
        expect(screen.getByText("2 tool results")).toBeInTheDocument();
      });

      it("does not render tool artifacts for calls without results", () => {
        const message: MessageWithToolInvocations = {
          id: "msg-9",
          role: "assistant",
          content: "Processing...",
          toolInvocations: [
            {
              toolCallId: "call-1",
              toolName: "search_messages",
              args: {},
              state: "result",
              // No result property
            },
          ],
        };

        render(<ChatMessage message={message} />);
        expect(screen.queryByTestId("tool-artifact")).not.toBeInTheDocument();
      });
    });

    describe("mixed tool states", () => {
      it("renders both pending and completed tool calls", () => {
        const message: MessageWithToolInvocations = {
          id: "msg-10",
          role: "assistant",
          content: "",
          toolInvocations: [
            {
              toolCallId: "call-1",
              toolName: "search_messages",
              args: {},
              state: "result",
              result: { results: [] },
            },
            {
              toolCallId: "call-2",
              toolName: "search_contacts",
              args: {},
              state: "call",
            },
          ],
        };

        render(<ChatMessage message={message} />);
        // Should show both completed artifact and pending indicator
        expect(screen.getByTestId("tool-artifact")).toBeInTheDocument();
        expect(screen.getByText(/Using search contacts.../i)).toBeInTheDocument();
      });
    });
  });

  describe("styling", () => {
    it("applies custom className", () => {
      const message: MessageWithToolInvocations = {
        id: "msg-11",
        role: "user",
        content: "Test",
      };

      render(<ChatMessage message={message} className="custom-class" />);
      // The className is applied to the Message component wrapper
      const messageElement = screen.getByText("Test").closest("[class*='custom-class']");
      expect(messageElement).toBeInTheDocument();
    });
  });

  describe("empty content", () => {
    it("renders nothing when assistant has no content and not streaming", () => {
      const message: MessageWithToolInvocations = {
        id: "msg-12",
        role: "assistant",
        content: "",
      };

      render(<ChatMessage message={message} isStreaming={false} />);
      // Should not show loader or content
      expect(screen.queryByTestId("loader")).not.toBeInTheDocument();
      expect(screen.queryByTestId("streamdown")).not.toBeInTheDocument();
    });
  });
});
