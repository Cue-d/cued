"use client";

import * as React from "react";
import { useChat } from "@ai-sdk/react";
import { useAccessToken } from "@workos-inc/authkit-nextjs/components";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useConvex } from "convex/react";
import { api } from "@cued/convex";
import {
  AssistantView,
  type MessageWithToolInvocations,
  type ToolInvocation,
  type MentionSearchResult,
} from "@cued/ui";

// Track mentions with both ID and display text to detect deletions
interface TrackedMention {
  id: string;
  displayText: string; // e.g., "@John Smith" or "@John Smith (Acme)"
}

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

function getReasoningContent(msg: UIMessage): string | undefined {
  // Extract reasoning content from thinking model responses
  // AI SDK uses { type: "reasoning", text: string } for reasoning parts
  const reasoningParts = msg.parts.filter(
    (part): part is { type: "reasoning"; text: string } =>
      part.type === "reasoning"
  );
  if (reasoningParts.length === 0) return undefined;
  return reasoningParts.map((part) => part.text).join("\n\n");
}

export default function AssistantPage() {
  const [input, setInput] = React.useState("");
  const [trackedMentions, setTrackedMentions] = React.useState<TrackedMention[]>(
    []
  );
  const { accessToken } = useAccessToken();
  const convex = useConvex();

  const accessTokenRef = React.useRef(accessToken);
  React.useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  // Search contacts for @mentions
  const searchContacts = React.useCallback(
    async (query: string): Promise<MentionSearchResult[]> => {
      try {
        const result = await convex.query(api.search.searchContacts, {
          query: query || "",
          limit: 10,
        });
        return result.results;
      } catch (error) {
        console.error("Failed to search contacts:", error);
        return [];
      }
    },
    [convex]
  );

  // Handle mention insertion - track contact IDs and display names
  const handleMentionInsert = React.useCallback(
    (contact: MentionSearchResult) => {
      setTrackedMentions((prev) => {
        // Avoid duplicates
        if (prev.some((m) => m.id === contact._id)) return prev;
        // Store the display name pattern to detect if mention was deleted
        return [...prev, { id: contact._id, displayText: `@${contact.displayName}` }];
      });
    },
    []
  );

  // Ref to track current trackedMentions for use in fetch
  const trackedMentionsRef = React.useRef(trackedMentions);
  React.useEffect(() => {
    trackedMentionsRef.current = trackedMentions;
  }, [trackedMentions]);

  // Ref to track current input for filtering mentions at send time
  const inputRef = React.useRef(input);
  React.useEffect(() => {
    inputRef.current = input;
  }, [input]);

  // Create transport once - ref ensures fetch always uses latest token and mentions
  const chatTransport = React.useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      new DefaultChatTransport({
        api: "/api/chat",
        fetch: (url, options) => {
          const token = accessTokenRef.current;
          const tracked = trackedMentionsRef.current;
          const currentInput = inputRef.current;
          const headers = {
            ...options?.headers,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          };

          // Filter to only contact IDs whose mention text is still in the input
          // This handles the case where user deleted a mention after inserting it
          const activeContactIds = tracked
            .filter((m) => currentInput.includes(m.displayText))
            .map((m) => m.id);

          // Inject mentionedContactIds into the request body
          let body = options?.body;
          if (body && activeContactIds.length > 0) {
            try {
              const parsed = JSON.parse(body as string);
              parsed.mentionedContactIds = activeContactIds;
              body = JSON.stringify(parsed);
            } catch (error) {
              // Log error - this indicates unexpected body format from AI SDK
              console.error(
                "Failed to inject mentionedContactIds into request body. Mentions will not be sent.",
                { bodyType: typeof body, contactCount: activeContactIds.length, error }
              );
            }
          }

          return fetch(url, { ...options, body, headers });
        },
      }),
    [] // Stable transport - refs provide latest values
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
      reasoning: getReasoningContent(msg),
    })
  );

  function handleSubmit() {
    if (!input.trim()) return;
    sendMessage({ parts: [{ type: "text", text: input }] });
    setInput("");
    // Clear tracked mentions after submission
    setTrackedMentions([]);
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
      searchContacts={searchContacts}
      onMentionInsert={handleMentionInsert}
    />
  );
}
