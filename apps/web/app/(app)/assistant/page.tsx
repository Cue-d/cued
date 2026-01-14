"use client"

import * as React from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport, type UIMessage } from "ai"

import {
  AssistantView,
  type MessageWithToolInvocations,
  type ToolInvocation,
} from "@prm/ui"

const transport = new DefaultChatTransport({
  api: "/api/assistant/chat",
})

function getTextContent(msg: UIMessage): string {
  return msg.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
}

function getToolInvocations(msg: UIMessage): ToolInvocation[] {
  return msg.parts
    .filter((part) => part.type.startsWith("tool-"))
    .map((part) => {
      const toolPart = part as {
        type: string
        toolCallId: string
        toolName: string
        state?: string
        args?: Record<string, unknown>
        input?: unknown
        result?: unknown
      }
      return {
        toolCallId: toolPart.toolCallId,
        toolName: toolPart.toolName,
        args: (toolPart.args || toolPart.input || {}) as Record<string, unknown>,
        state: (toolPart.state || "call") as "partial-call" | "call" | "result",
        result: toolPart.result,
      }
    })
}

export default function AssistantPage() {
  const [input, setInput] = React.useState("")
  const { messages, sendMessage, status, error, stop } = useChat({ transport })

  const isLoading = status === "submitted" || status === "streaming"

  const formattedMessages: MessageWithToolInvocations[] = messages.map((msg) => ({
    id: msg.id,
    role: msg.role as "user" | "assistant",
    content: getTextContent(msg),
    toolInvocations: getToolInvocations(msg),
  }))

  function handleSubmit() {
    if (!input.trim()) return
    sendMessage({ parts: [{ type: "text", text: input }] })
    setInput("")
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
  )
}
