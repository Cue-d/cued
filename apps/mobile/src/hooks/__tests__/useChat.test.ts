import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChat as useAIChat } from "@ai-sdk/react";
import { useChat } from "../useChat";

// Mock @ai-sdk/react
vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn(),
}));

// Mock expo/fetch
vi.mock("expo/fetch", () => ({
  fetch: vi.fn(),
}));

// Mock ai module for DefaultChatTransport
vi.mock("ai", () => ({
  DefaultChatTransport: vi.fn().mockImplementation((config) => ({
    api: config.api,
    fetch: config.fetch,
  })),
}));

const mockUseAIChat = vi.mocked(useAIChat);

describe("useChat", () => {
  const defaultMockReturn = {
    messages: [],
    sendMessage: vi.fn(),
    status: "ready",
    error: null,
    setMessages: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAIChat.mockReturnValue(defaultMockReturn as never);
  });

  describe("initial state", () => {
    it("returns empty messages initially", () => {
      const { result } = renderHook(() => useChat());

      expect(result.current.messages).toEqual([]);
    });

    it("returns empty input initially", () => {
      const { result } = renderHook(() => useChat());

      expect(result.current.input).toBe("");
    });

    it("returns isLoading=false when status is ready", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        status: "ready",
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.isLoading).toBe(false);
    });

    it("returns null error initially", () => {
      const { result } = renderHook(() => useChat());

      expect(result.current.error).toBeNull();
    });
  });

  describe("input handling", () => {
    it("updates input when setInput is called", () => {
      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.setInput("Hello, world!");
      });

      expect(result.current.input).toBe("Hello, world!");
    });

    it("clears input after setInput with empty string", () => {
      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.setInput("Some text");
      });
      expect(result.current.input).toBe("Some text");

      act(() => {
        result.current.setInput("");
      });
      expect(result.current.input).toBe("");
    });
  });

  describe("loading state", () => {
    it("returns isLoading=true when status is streaming", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        status: "streaming",
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.isLoading).toBe(true);
    });

    it("returns isLoading=true when status is submitted", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        status: "submitted",
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.isLoading).toBe(true);
    });

    it("returns isLoading=false when status is error", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        status: "error",
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("sendMessage", () => {
    it("calls AI SDK sendMessage with input text", async () => {
      const mockSendMessage = vi.fn();
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        sendMessage: mockSendMessage,
      } as never);

      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.setInput("Hello!");
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockSendMessage).toHaveBeenCalledWith({ text: "Hello!" });
    });

    it("clears input after sending message", async () => {
      const mockSendMessage = vi.fn();
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        sendMessage: mockSendMessage,
      } as never);

      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.setInput("Hello!");
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(result.current.input).toBe("");
    });

    it("can send message with explicit content parameter", async () => {
      const mockSendMessage = vi.fn();
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        sendMessage: mockSendMessage,
      } as never);

      const { result } = renderHook(() => useChat());

      await act(async () => {
        await result.current.sendMessage("Direct message");
      });

      expect(mockSendMessage).toHaveBeenCalledWith({ text: "Direct message" });
    });

    it("does not send empty messages", async () => {
      const mockSendMessage = vi.fn();
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        sendMessage: mockSendMessage,
      } as never);

      const { result } = renderHook(() => useChat());

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("does not send whitespace-only messages", async () => {
      const mockSendMessage = vi.fn();
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        sendMessage: mockSendMessage,
      } as never);

      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.setInput("   ");
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("trims whitespace from message", async () => {
      const mockSendMessage = vi.fn();
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        sendMessage: mockSendMessage,
      } as never);

      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.setInput("  Hello  ");
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockSendMessage).toHaveBeenCalledWith({ text: "Hello" });
    });
  });

  describe("message transformation", () => {
    it("transforms user messages correctly", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        messages: [
          {
            id: "msg1",
            role: "user",
            parts: [{ type: "text", text: "Hello" }],
          },
        ],
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.messages).toEqual([
        {
          id: "msg1",
          role: "user",
          content: "Hello",
          toolInvocations: undefined,
        },
      ]);
    });

    it("transforms assistant messages correctly", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        messages: [
          {
            id: "msg2",
            role: "assistant",
            parts: [{ type: "text", text: "Hi there!" }],
          },
        ],
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.messages).toEqual([
        {
          id: "msg2",
          role: "assistant",
          content: "Hi there!",
          toolInvocations: undefined,
        },
      ]);
    });

    it("concatenates multiple text parts", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        messages: [
          {
            id: "msg3",
            role: "assistant",
            parts: [
              { type: "text", text: "First " },
              { type: "text", text: "Second" },
            ],
          },
        ],
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.messages[0].content).toBe("First Second");
    });

    it("handles messages without parts", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        messages: [
          {
            id: "msg4",
            role: "assistant",
            parts: undefined,
          },
        ],
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.messages[0].content).toBe("");
    });
  });

  describe("tool invocations", () => {
    it("extracts tool invocations from message parts", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        messages: [
          {
            id: "msg5",
            role: "assistant",
            parts: [
              {
                type: "tool-searchMessages",
                toolCallId: "call1",
                input: { query: "test" },
                state: "output-available",
                output: { results: [] },
              },
            ],
          },
        ],
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.messages[0].toolInvocations).toEqual([
        {
          toolCallId: "call1",
          toolName: "searchMessages",
          args: { query: "test" },
          state: "result",
          result: { results: [] },
        },
      ]);
    });

    it("maps input-streaming state to partial-call", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        messages: [
          {
            id: "msg6",
            role: "assistant",
            parts: [
              {
                type: "tool-getContacts",
                toolCallId: "call2",
                input: {},
                state: "input-streaming",
                output: undefined,
              },
            ],
          },
        ],
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.messages[0].toolInvocations?.[0].state).toBe("partial-call");
    });

    it("maps output-error state to result", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        messages: [
          {
            id: "msg7",
            role: "assistant",
            parts: [
              {
                type: "tool-action",
                toolCallId: "call3",
                input: {},
                state: "output-error",
                output: null,
              },
            ],
          },
        ],
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.messages[0].toolInvocations?.[0].state).toBe("result");
    });

    it("maps unknown state to call", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        messages: [
          {
            id: "msg8",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "call4",
                input: { q: "test" },
                state: "pending",
                output: undefined,
              },
            ],
          },
        ],
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.messages[0].toolInvocations?.[0].state).toBe("call");
    });
  });

  describe("clearMessages", () => {
    it("calls setMessages with empty array", () => {
      const mockSetMessages = vi.fn();
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        setMessages: mockSetMessages,
      } as never);

      const { result } = renderHook(() => useChat());

      act(() => {
        result.current.clearMessages();
      });

      expect(mockSetMessages).toHaveBeenCalledWith([]);
    });
  });

  describe("error handling", () => {
    it("returns error from AI SDK", () => {
      const testError = new Error("API error");
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        error: testError,
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.error).toBe(testError);
    });

    it("returns null when no error", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        error: null,
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.error).toBeNull();
    });

    it("coerces undefined error to null", () => {
      mockUseAIChat.mockReturnValue({
        ...defaultMockReturn,
        error: undefined,
      } as never);

      const { result } = renderHook(() => useChat());

      expect(result.current.error).toBeNull();
    });
  });

  describe("options", () => {
    it("uses default API path /api/chat", () => {
      renderHook(() => useChat());

      expect(mockUseAIChat).toHaveBeenCalledWith(
        expect.objectContaining({
          transport: expect.anything(),
        })
      );
    });

    it("accepts custom API path", () => {
      renderHook(() => useChat({ apiPath: "/api/custom-chat" }));

      expect(mockUseAIChat).toHaveBeenCalled();
    });

    it("accepts getAccessToken option", () => {
      const mockGetToken = vi.fn().mockResolvedValue("test-token");

      renderHook(() => useChat({ getAccessToken: mockGetToken }));

      expect(mockUseAIChat).toHaveBeenCalled();
    });
  });
});
