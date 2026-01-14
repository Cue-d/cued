"use client";

import * as React from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useAccessToken } from "@workos-inc/authkit-nextjs/components";

import {
  AssistantView,
  type MessageWithToolInvocations,
  type ToolInvocation,
} from "@prm/ui";

function getTextContent(msg: UIMessage): string {
  return msg.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function getToolInvocations(msg: UIMessage): ToolInvocation[] {
  return msg.parts
    .filter((part) => part.type.startsWith("tool-"))
    .map((part) => {
      const toolPart = part as {
        type: string;
        toolCallId: string;
        toolName: string;
        state?: string;
        args?: Record<string, unknown>;
        input?: unknown;
        result?: unknown;
      };
      return {
        toolCallId: toolPart.toolCallId,
        toolName: toolPart.toolName,
        args: (toolPart.args || toolPart.input || {}) as Record<
          string,
          unknown
        >,
        state: (toolPart.state || "call") as "partial-call" | "call" | "result",
        result: toolPart.result,
      };
    });
}

export default function AssistantPage() {
  const [input, setInput] = React.useState("");
  const [syncStatus, setSyncStatus] = React.useState<string | null>(null);
  const { accessToken } = useAccessToken();

  // Temporary test function for memory sync
  async function testMemorySync() {
    if (!accessToken) {
      setSyncStatus("No access token");
      return;
    }
    setSyncStatus("Syncing...");
    try {
      const res = await fetch("/api/memories/sync", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: "imessage" }),
      });
      const data = await res.json();
      setSyncStatus(JSON.stringify(data, null, 2));
    } catch (e) {
      setSyncStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Process a batch of messages for memory extraction (backfill)
  async function processBatch() {
    if (!accessToken) {
      setSyncStatus("No access token");
      return;
    }
    setSyncStatus("Processing batch...");
    try {
      const res = await fetch("/api/memories/process", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: "imessage" }),
      });
      const data = await res.json();
      setSyncStatus(JSON.stringify(data, null, 2));
    } catch (e) {
      setSyncStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Get processing status
  async function getStatus() {
    if (!accessToken) {
      setSyncStatus("No access token");
      return;
    }
    setSyncStatus("Loading status...");
    try {
      const res = await fetch("/api/memories/process?platform=imessage", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      setSyncStatus(JSON.stringify(data, null, 2));
    } catch (e) {
      setSyncStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Use ref to always get latest token in fetch callback (avoids stale closure)
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
    [], // Stable transport - ref provides latest token
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
    }),
  );

  function handleSubmit() {
    if (!input.trim()) return;
    sendMessage({ parts: [{ type: "text", text: input }] });
    setInput("");
  }

  return (
    <div className="h-full flex flex-col">
      {/* Temporary test buttons */}
      <div className="p-2 border-b flex items-center gap-2 bg-yellow-50 flex-wrap">
        <button
          onClick={testMemorySync}
          className="px-3 py-1 bg-blue-500 text-white rounded text-sm hover:bg-blue-600"
        >
          Sync New
        </button>
        <button
          onClick={processBatch}
          className="px-3 py-1 bg-green-500 text-white rounded text-sm hover:bg-green-600"
        >
          Process Batch (50)
        </button>
        <button
          onClick={getStatus}
          className="px-3 py-1 bg-gray-500 text-white rounded text-sm hover:bg-gray-600"
        >
          Get Status
        </button>
        {syncStatus && (
          <pre className="text-xs bg-gray-100 p-2 rounded max-w-xl overflow-auto max-h-32">
            {syncStatus}
          </pre>
        )}
      </div>
      <AssistantView
        messages={formattedMessages}
        input={input}
        onInputChange={setInput}
        onSubmit={handleSubmit}
        onStop={stop}
        isLoading={isLoading}
        error={error}
        className="flex-1"
      />
    </div>
  );
}
