"use client";

import * as React from "react";
import { useChat } from "@ai-sdk/react";
import { useAccessToken } from "@workos-inc/authkit-nextjs/components";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  AssistantView,
  type MessageWithToolInvocations,
  type ToolInvocation,
} from "@prm/ui";

function getTextContent(msg: UIMessage): string {
  return msg.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

function getToolInvocations(msg: UIMessage): ToolInvocation[] {
  return msg.parts
    .filter(
      (part) => part.type.startsWith("tool-") || part.type === "dynamic-tool"
    )
    .map((part) => {
      const toolPart = part as {
        type: string;
        toolCallId: string;
        toolName?: string; // For dynamic-tool type
        state: string;
        input?: unknown;
        output?: unknown;
      };

      // Extract tool name: from type for static tools, or from toolName for dynamic tools
      const toolName =
        toolPart.type === "dynamic-tool"
          ? toolPart.toolName || "unknown"
          : toolPart.type.replace(/^tool-/, "");

      // Map AI SDK states to our simplified states
      let state: "partial-call" | "call" | "result";
      if (toolPart.state === "input-streaming") {
        state = "partial-call";
      } else if (
        toolPart.state === "output-available" ||
        toolPart.state === "output-error"
      ) {
        state = "result";
      } else {
        state = "call";
      }

      return {
        toolCallId: toolPart.toolCallId,
        toolName,
        args: (toolPart.input || {}) as Record<string, unknown>,
        state,
        result: toolPart.output,
      };
    });
}

export default function AssistantPage() {
  const [input, setInput] = React.useState("");
  const { accessToken } = useAccessToken();

  const accessTokenRef = React.useRef(accessToken);
  React.useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  // Create transport once - ref ensures fetch always uses latest token
  const chatTransport = React.useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      new DefaultChatTransport({
        api: "/api/chat",
        fetch: (url, options) => {
          const token = accessTokenRef.current;
          const headers = {
            ...options?.headers,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          };
          return fetch(url, { ...options, headers });
        },
      }),
    [] // Stable transport - ref provides latest token
  );

  const { messages, sendMessage, status, error, stop } = useChat({
    transport: chatTransport,
  });

  const isLoading = status === "submitted" || status === "streaming";

  const formattedMessages: MessageWithToolInvocations[] = messages.map(
    (msg) => ({
      id: msg.id,
      role: msg.role as "user" | "assistant",
      content: getTextContent(msg),
      toolInvocations: getToolInvocations(msg),
    })
  );

  function handleSubmit() {
    if (!input.trim()) return;
    sendMessage({ parts: [{ type: "text", text: input }] });
    setInput("");
  }

  return (
    <AssistantView
      messages={formattedMessages}
      input={input}
      onInputChange={setInput}
      onSubmit={handleSubmit}
      onStop={stop}
      isLoading={isLoading}
      error={error}
      className="h-full"
    />
  );
}
