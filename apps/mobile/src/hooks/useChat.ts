import { useCallback, useMemo, useState } from "react";
import { useChat as useAIChat } from "@ai-sdk/react";
import { DefaultChatTransport, UIMessage } from "ai";
import { fetch as expoFetch } from "expo/fetch";
import { clientEnv } from "@cued/env/client";
import type { ChatMessageData, ToolInvocation } from "@/components/chat/chat-message";

const API_URL = clientEnv.EXPO_PUBLIC_API_URL || "http://localhost:3000";

/** Maps AI SDK tool state to our internal state format */
function mapToolState(sdkState: string): ToolInvocation["state"] {
  if (sdkState === "input-streaming") return "partial-call";
  if (sdkState === "output-available" || sdkState === "output-error") return "result";
  return "call";
}

interface UseChatOptions {
  /** API endpoint path (default: /api/chat) */
  apiPath?: string;
  /** Function to get auth token for API requests */
  getAccessToken?: () => Promise<string | null>;
}

interface UseChatReturn {
  messages: ChatMessageData[];
  input: string;
  setInput: (text: string) => void;
  sendMessage: (content?: string) => Promise<void>;
  isLoading: boolean;
  error: Error | null;
  clearMessages: () => void;
}

/**
 * Custom useChat hook for React Native/Expo.
 * Uses AI SDK's useChat with expo/fetch for streaming support.
 */
export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const { apiPath = "/api/chat", getAccessToken } = options;

  // Manage input state ourselves (useChat from @ai-sdk/react doesn't provide this)
  const [input, setInput] = useState("");

  // Create transport with expo/fetch for streaming and auth headers
  const transport = useMemo(() => {
    return new DefaultChatTransport<UIMessage>({
      api: `${API_URL}${apiPath}`,
      fetch: async (url, init) => {
        const token = getAccessToken ? await getAccessToken() : null;
        const { body, signal, ...restInit } = init ?? {};

        return expoFetch(url as string, {
          ...restInit,
          body: body ?? undefined,
          signal: signal ?? undefined,
          headers: {
            ...init?.headers,
            ...(token && { Authorization: `Bearer ${token}` }),
          },
        }) as Promise<Response>;
      },
    });
  }, [apiPath, getAccessToken]);

  const {
    messages: aiMessages,
    sendMessage: aiSendMessage,
    status,
    error,
    setMessages,
  } = useAIChat({
    transport,
    onError: (err) => console.error("[useChat] Error:", err),
  });

  // Convert AI SDK messages to our ChatMessageData format
  const messages: ChatMessageData[] = useMemo(() => {
    return aiMessages.map((msg) => {
      // Extract text content from parts
      const textContent = msg.parts
        ?.filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("") || "";

      // Extract tool invocations from parts (AI SDK uses "tool-{name}" type format)
      const toolInvocations: ToolInvocation[] = msg.parts
        ?.filter((part) => part.type.startsWith("tool-"))
        .map((part) => {
          const toolPart = part as Record<string, unknown>;
          return {
            toolCallId: toolPart.toolCallId as string,
            toolName: part.type.replace(/^tool-/, ""),
            args: (toolPart.input as Record<string, unknown>) ?? {},
            state: mapToolState(toolPart.state as string),
            result: toolPart.output,
          };
        }) || [];

      return {
        id: msg.id,
        role: msg.role as "user" | "assistant",
        content: textContent,
        toolInvocations: toolInvocations.length > 0 ? toolInvocations : undefined,
      };
    });
  }, [aiMessages]);

  const isLoading = status === "streaming" || status === "submitted";

  const sendMessage = useCallback(
    async (content?: string) => {
      const messageContent = content ?? input;
      if (!messageContent.trim()) return;

      // Clear input if using the input state
      if (!content) {
        setInput("");
      }

      // Use sendMessage with text property
      await aiSendMessage({ text: messageContent.trim() });
    },
    [input, aiSendMessage]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, [setMessages]);

  return {
    messages,
    input,
    setInput,
    sendMessage,
    isLoading,
    error: error || null,
    clearMessages,
  };
}
