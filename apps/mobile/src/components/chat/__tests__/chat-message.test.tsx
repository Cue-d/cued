import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { ChatMessage, type ChatMessageData, type ToolInvocation } from "../chat-message";

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
    success: "#22C55E",
  }),
}));

// Mock AnimatedView to just render children
vi.mock("@/components/animated", () => ({
  AnimatedView: ({ children }: { children?: React.ReactNode }) => children,
}));

// Mock ToolArtifacts to simplify testing
vi.mock("../tool-artifact", () => ({
  ToolArtifacts: ({ toolInvocations }: { toolInvocations: unknown[] }) => (
    <div data-testid="tool-artifacts" data-count={toolInvocations.length}>
      Tool Artifacts
    </div>
  ),
}));

describe("ChatMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createUserMessage = (overrides: Partial<ChatMessageData> = {}): ChatMessageData => ({
    id: `msg-${Math.random().toString(36).substr(2, 9)}`,
    role: "user",
    content: "Hello, how are you?",
    ...overrides,
  });

  const createAssistantMessage = (overrides: Partial<ChatMessageData> = {}): ChatMessageData => ({
    id: `msg-${Math.random().toString(36).substr(2, 9)}`,
    role: "assistant",
    content: "I'm doing well, thank you!",
    ...overrides,
  });

  describe("user messages", () => {
    it("renders user message content", () => {
      const message = createUserMessage({ content: "Test user message" });
      render(<ChatMessage message={message} />);

      expect(screen.getByText("Test user message")).toBeDefined();
    });

    it("renders user message without assistant styling prefix", () => {
      const message = createUserMessage({ content: "User content" });
      render(<ChatMessage message={message} />);

      // User messages should not have the "> " prefix
      expect(screen.queryByText(/^> /)).toBeNull();
    });

    it("renders user message with selectable text", () => {
      const message = createUserMessage();
      render(<ChatMessage message={message} />);

      expect(screen.getByText("Hello, how are you?")).toBeDefined();
    });
  });

  describe("assistant messages", () => {
    it("renders assistant message content", () => {
      const message = createAssistantMessage({ content: "Test assistant response" });
      render(<ChatMessage message={message} />);

      expect(screen.getByText("Test assistant response")).toBeDefined();
    });

    it("renders assistant message with '>' prefix", () => {
      const message = createAssistantMessage({ content: "Response text" });
      const { container } = render(<ChatMessage message={message} />);

      // The prefix is rendered as a Text element with "> " content
      // In jsdom, the > character is rendered as HTML entity
      const prefixElement = container.querySelector('text[class*="muted-foreground"]');
      expect(prefixElement?.textContent).toBe("> ");
    });

    it("renders typing indicator when streaming with empty content", () => {
      const message = createAssistantMessage({ content: "" });
      render(<ChatMessage message={message} isStreaming={true} />);

      expect(screen.getByText("Thinking...")).toBeDefined();
    });

    it("does not render typing indicator when streaming with content", () => {
      const message = createAssistantMessage({ content: "Some content" });
      render(<ChatMessage message={message} isStreaming={true} />);

      expect(screen.queryByText("Thinking...")).toBeNull();
      expect(screen.getByText("Some content")).toBeDefined();
    });

    it("does not render typing indicator when not streaming", () => {
      const message = createAssistantMessage({ content: "" });
      render(<ChatMessage message={message} isStreaming={false} />);

      expect(screen.queryByText("Thinking...")).toBeNull();
    });
  });

  describe("markdown rendering", () => {
    it("renders bold text", () => {
      const message = createAssistantMessage({ content: "This is **bold** text" });
      render(<ChatMessage message={message} />);

      // The word "bold" should be rendered (markdown parsing)
      expect(screen.getByText("bold")).toBeDefined();
    });

    it("renders inline code", () => {
      const message = createAssistantMessage({ content: "Use the `console.log` function" });
      render(<ChatMessage message={message} />);

      expect(screen.getByText("console.log")).toBeDefined();
    });

    it("renders plain text without markdown", () => {
      const message = createAssistantMessage({ content: "Plain text message" });
      render(<ChatMessage message={message} />);

      expect(screen.getByText("Plain text message")).toBeDefined();
    });

    it("handles multiple markdown elements", () => {
      const message = createAssistantMessage({ content: "**Bold** and `code`" });
      render(<ChatMessage message={message} />);

      expect(screen.getByText("Bold")).toBeDefined();
      expect(screen.getByText("code")).toBeDefined();
    });
  });

  describe("tool invocations", () => {
    const createToolInvocation = (overrides: Partial<ToolInvocation> = {}): ToolInvocation => ({
      toolCallId: `call-${Math.random().toString(36).substr(2, 9)}`,
      toolName: "search_messages",
      args: {},
      state: "result",
      result: { results: [] },
      ...overrides,
    });

    it("renders pending tool indicator for call state", () => {
      const message = createAssistantMessage({
        content: "",
        toolInvocations: [createToolInvocation({ state: "call" })],
      });
      render(<ChatMessage message={message} />);

      expect(screen.getByText(/Using search messages.../)).toBeDefined();
    });

    it("renders pending tool indicator for partial-call state", () => {
      const message = createAssistantMessage({
        content: "",
        toolInvocations: [createToolInvocation({ state: "partial-call" })],
      });
      render(<ChatMessage message={message} />);

      expect(screen.getByText(/Using search messages.../)).toBeDefined();
    });

    it("formats tool name by replacing underscores with spaces", () => {
      const message = createAssistantMessage({
        content: "",
        toolInvocations: [
          createToolInvocation({ state: "call", toolName: "create_action" }),
        ],
      });
      render(<ChatMessage message={message} />);

      expect(screen.getByText(/Using create action.../)).toBeDefined();
    });

    it("renders ToolArtifacts for completed tool invocations", () => {
      const message = createAssistantMessage({
        content: "Here are the results",
        toolInvocations: [
          createToolInvocation({ state: "result", result: { results: [] } }),
        ],
      });
      render(<ChatMessage message={message} />);

      expect(screen.getByTestId("tool-artifacts")).toBeDefined();
    });

    it("does not render ToolArtifacts when no tool invocations", () => {
      const message = createAssistantMessage({ content: "No tools used" });
      render(<ChatMessage message={message} />);

      expect(screen.queryByTestId("tool-artifacts")).toBeNull();
    });

    it("handles multiple pending tool calls", () => {
      const message = createAssistantMessage({
        content: "",
        toolInvocations: [
          createToolInvocation({ state: "call", toolName: "search_messages" }),
          createToolInvocation({ state: "call", toolName: "search_contacts" }),
        ],
      });
      render(<ChatMessage message={message} />);

      expect(screen.getByText(/Using search messages.../)).toBeDefined();
      expect(screen.getByText(/Using search contacts.../)).toBeDefined();
    });

    it("shows both pending indicators and ToolArtifacts for mixed states", () => {
      const message = createAssistantMessage({
        content: "Processing...",
        toolInvocations: [
          createToolInvocation({ state: "call", toolName: "search_messages" }),
          createToolInvocation({ state: "result", toolName: "search_contacts", result: { results: [] } }),
        ],
      });
      render(<ChatMessage message={message} />);

      expect(screen.getByText(/Using search messages.../)).toBeDefined();
      expect(screen.getByTestId("tool-artifacts")).toBeDefined();
    });
  });

  describe("isStreaming prop", () => {
    it("defaults to false", () => {
      const message = createAssistantMessage({ content: "" });
      render(<ChatMessage message={message} />);

      // When not streaming and empty content, no typing indicator
      expect(screen.queryByText("Thinking...")).toBeNull();
    });

    it("shows typing indicator when isStreaming=true and content empty", () => {
      const message = createAssistantMessage({ content: "" });
      render(<ChatMessage message={message} isStreaming={true} />);

      expect(screen.getByText("Thinking...")).toBeDefined();
    });

    it("shows content when isStreaming=true and content exists", () => {
      const message = createAssistantMessage({ content: "Partial response" });
      render(<ChatMessage message={message} isStreaming={true} />);

      expect(screen.getByText("Partial response")).toBeDefined();
      expect(screen.queryByText("Thinking...")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles empty content for user message", () => {
      const message = createUserMessage({ content: "" });
      render(<ChatMessage message={message} />);

      // Should render without crashing
      expect(document.body).toBeDefined();
    });

    it("handles special characters in content", () => {
      const message = createUserMessage({ content: "Hello! <script>alert('xss')</script>" });
      render(<ChatMessage message={message} />);

      expect(screen.getByText(/Hello!/)).toBeDefined();
    });

    it("handles very long content", () => {
      const longContent = "A".repeat(1000);
      const message = createAssistantMessage({ content: longContent });
      render(<ChatMessage message={message} />);

      expect(screen.getByText(longContent)).toBeDefined();
    });

    it("handles emoji content", () => {
      const message = createUserMessage({ content: "Hello 👋 World 🌍" });
      render(<ChatMessage message={message} />);

      expect(screen.getByText("Hello 👋 World 🌍")).toBeDefined();
    });
  });
});
