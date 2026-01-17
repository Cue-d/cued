import { useState, useCallback, useRef } from "react";
import type { ChatMessageData, ToolInvocation } from "@/components/chat/chat-message";

// API base URL - use the web app's API
const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:3000";

// Message format expected by the API (UI message format)
interface APIMessagePart {
  type: "text";
  text: string;
}

interface APIMessage {
  id: string;
  role: "user" | "assistant";
  parts: APIMessagePart[];
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
 * Generate a unique ID for messages
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Parse SSE data line into event and data
 */
function parseSSELine(line: string): { event: string | null; data: string | null } {
  if (line.startsWith("event:")) {
    return { event: line.slice(6).trim(), data: null };
  }
  if (line.startsWith("data:")) {
    return { event: null, data: line.slice(5).trim() };
  }
  return { event: null, data: null };
}

/**
 * Custom useChat hook for React Native.
 * Streams responses from /api/chat endpoint using SSE.
 */
export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const { apiPath = "/api/chat", getAccessToken } = options;

  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Track current stream for abort
  const abortControllerRef = useRef<AbortController | null>(null);
  // Track current assistant message ID during streaming
  const currentAssistantIdRef = useRef<string | null>(null);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  const sendMessage = useCallback(
    async (content?: string) => {
      const messageContent = content ?? input;
      if (!messageContent.trim()) return;

      // Clear input immediately
      setInput("");
      setError(null);
      setIsLoading(true);

      // Create user message
      const userMessage: ChatMessageData = {
        id: generateId(),
        role: "user",
        content: messageContent.trim(),
      };

      // Create placeholder assistant message for streaming
      const assistantMessageId = generateId();
      currentAssistantIdRef.current = assistantMessageId;

      const assistantMessage: ChatMessageData = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        toolInvocations: [],
      };

      // Add both messages
      setMessages((prev) => [...prev, userMessage, assistantMessage]);

      // Build API messages (convert to API format)
      const apiMessages: APIMessage[] = [
        ...messages.map((m) => ({
          id: m.id,
          role: m.role,
          parts: [{ type: "text" as const, text: m.content }],
        })),
        {
          id: userMessage.id,
          role: "user" as const,
          parts: [{ type: "text" as const, text: userMessage.content }],
        },
      ];

      try {
        // Abort any existing request
        abortControllerRef.current?.abort();
        abortControllerRef.current = new AbortController();

        // Get auth token if available
        let authHeader: string | undefined;
        if (getAccessToken) {
          const token = await getAccessToken();
          if (token) {
            authHeader = `Bearer ${token}`;
          }
        }

        const response = await fetch(`${API_URL}${apiPath}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
          body: JSON.stringify({ messages: apiMessages }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error("No response body");
        }

        // Read stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let buffer = "";
        let currentEvent: string | null = null;
        let accumulatedContent = "";
        const toolInvocations: Map<string, ToolInvocation> = new Map();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              currentEvent = null;
              continue;
            }

            const { event, data } = parseSSELine(trimmed);

            if (event) {
              currentEvent = event;
              continue;
            }

            if (data) {
              try {
                // Parse the AI SDK stream format
                // UI message stream uses specific event types
                if (currentEvent === "text" || currentEvent === "text-delta") {
                  // Text delta - append to content
                  const parsed = JSON.parse(data);
                  if (typeof parsed === "string") {
                    accumulatedContent += parsed;
                  } else if (parsed.textDelta) {
                    accumulatedContent += parsed.textDelta;
                  }
                } else if (currentEvent === "tool-call" || currentEvent === "tool-result") {
                  // Tool invocation updates
                  const parsed = JSON.parse(data);
                  if (parsed.toolCallId) {
                    const existing = toolInvocations.get(parsed.toolCallId);
                    const updated: ToolInvocation = {
                      toolCallId: parsed.toolCallId,
                      toolName: parsed.toolName || existing?.toolName || "unknown",
                      args: parsed.args || existing?.args || {},
                      state: currentEvent === "tool-result" ? "result" : "call",
                      result: parsed.result ?? existing?.result,
                    };
                    toolInvocations.set(parsed.toolCallId, updated);
                  }
                } else if (!currentEvent || currentEvent === "message") {
                  // Generic data - try to parse as text
                  try {
                    const parsed = JSON.parse(data);
                    if (typeof parsed === "string") {
                      accumulatedContent += parsed;
                    }
                  } catch {
                    // Not JSON, treat as raw text
                    accumulatedContent += data;
                  }
                }

                // Update assistant message
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMessageId
                      ? {
                          ...m,
                          content: accumulatedContent,
                          toolInvocations: Array.from(toolInvocations.values()),
                        }
                      : m
                  )
                );
              } catch {
                // Ignore parse errors for individual chunks
              }
            }
          }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
          const { data } = parseSSELine(buffer.trim());
          if (data) {
            try {
              const parsed = JSON.parse(data);
              if (typeof parsed === "string") {
                accumulatedContent += parsed;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMessageId
                      ? { ...m, content: accumulatedContent }
                      : m
                  )
                );
              }
            } catch {
              // Ignore
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // Request was aborted, not an error
          return;
        }
        const error = err instanceof Error ? err : new Error("Unknown error");
        setError(error);

        // Remove empty assistant message on error
        setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
      } finally {
        setIsLoading(false);
        currentAssistantIdRef.current = null;
        abortControllerRef.current = null;
      }
    },
    [input, messages, apiPath, getAccessToken]
  );

  return {
    messages,
    input,
    setInput,
    sendMessage,
    isLoading,
    error,
    clearMessages,
  };
}
