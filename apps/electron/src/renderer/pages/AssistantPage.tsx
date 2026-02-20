import * as React from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport, type UIMessage } from "ai"
import { useConvex } from "convex/react"
import { MessageCircle } from 'lucide-react'
import { api } from "@cued/convex"
import {
  AssistantView,
  type MessageWithToolInvocations,
  type ToolInvocation,
  type MentionSearchResult,
} from "@cued/ui"
import { Button } from "@cued/ui"
import { Panel, PanelHeader } from "../components/app-shell"
import { useElectron } from "../hooks/use-electron"

// Track mentions with both ID and display text to detect deletions
interface TrackedMention {
  id: string
  displayText: string
}

function getTextContent(msg: UIMessage): string {
  return msg.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
}

interface ToolPart {
  type: string
  toolCallId: string
  toolName?: string
  state: string
  input?: unknown
  output?: unknown
}

function mapToolState(state: string): "partial-call" | "call" | "result" {
  if (state === "input-streaming") return "partial-call"
  if (state === "output-available" || state === "output-error") return "result"
  return "call"
}

function getToolInvocations(msg: UIMessage): ToolInvocation[] {
  return msg.parts
    .filter((part) => part.type.startsWith("tool-") || part.type === "dynamic-tool")
    .map((part) => {
      const toolPart = part as ToolPart
      const toolName = toolPart.type === "dynamic-tool"
        ? (toolPart.toolName ?? "unknown")
        : toolPart.type.replace(/^tool-/, "")

      return {
        toolCallId: toolPart.toolCallId,
        toolName,
        args: (toolPart.input ?? {}) as Record<string, unknown>,
        state: mapToolState(toolPart.state),
        result: toolPart.output,
      }
    })
}

function getReasoningContent(msg: UIMessage): string | undefined {
  const reasoningParts = msg.parts.filter(
    (part): part is { type: "reasoning"; text: string } => part.type === "reasoning"
  )
  return reasoningParts.length > 0
    ? reasoningParts.map((part) => part.text).join("\n\n")
    : undefined
}

interface ChatListItem {
  id: string
  title: string
  isActive: boolean
}

function ChatListItemRow({
  chat,
  selected,
  onClick,
}: {
  chat: ChatListItem
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
        selected ? "bg-foreground/[0.07]" : "hover:bg-foreground/5"
      }`}
    >
      <div className="flex items-center gap-3">
        <MessageCircle size={16} strokeWidth={1.5} className="text-muted-foreground" />
        <span className="text-sm font-medium">{chat.title}</span>
      </div>
    </button>
  )
}

// Separate component that only mounts when transport is ready
// This ensures useChat is only called with a valid transport
function ChatPanel({
  transport,
  searchContacts,
  onMentionInsert,
}: {
  transport: DefaultChatTransport<UIMessage>
  searchContacts: (query: string) => Promise<MentionSearchResult[]>
  onMentionInsert: (contact: MentionSearchResult) => void
}) {
  const [input, setInput] = React.useState("")

  const { messages, sendMessage, status, error, stop } = useChat({
    transport,
  })

  const isLoading = status === "submitted" || status === "streaming"

  const formattedMessages: MessageWithToolInvocations[] = messages.map(
    (msg) => ({
      id: msg.id,
      role: msg.role as "user" | "assistant",
      content: getTextContent(msg),
      toolInvocations: getToolInvocations(msg),
      reasoning: getReasoningContent(msg),
    })
  )

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
      searchContacts={searchContacts}
      onMentionInsert={onMentionInsert}
    />
  )
}

export function AssistantPage(): React.JSX.Element {
  const [trackedMentions, setTrackedMentions] = React.useState<TrackedMention[]>([])
  const [appUrl, setAppUrl] = React.useState<string | null>(null)
  const convex = useConvex()
  const electron = useElectron()

  // Get app URL from electron config
  React.useEffect(() => {
    electron.config.getAppUrl().then(setAppUrl)
  }, [electron])

  // TODO: Replace with persistent chat history from Convex (list, create, delete)
  const [chats] = React.useState<ChatListItem[]>([
    { id: "new", title: "New chat", isActive: true },
  ])
  const [selectedChatId] = React.useState<string>("new")

  // Refs for use in fetch - need to track mentions for the transport
  const trackedMentionsRef = React.useRef(trackedMentions)
  React.useEffect(() => {
    trackedMentionsRef.current = trackedMentions
  }, [trackedMentions])

  // Search contacts for @mentions
  const searchContacts = React.useCallback(
    async (query: string): Promise<MentionSearchResult[]> => {
      try {
        const result = await convex.query(api.search.searchContacts, {
          query: query || "",
          limit: 10,
        })
        return result.results
      } catch (error) {
        console.error("Failed to search contacts:", error)
        return []
      }
    },
    [convex]
  )

  // Handle mention insertion
  const handleMentionInsert = React.useCallback(
    (contact: MentionSearchResult) => {
      setTrackedMentions((prev) => {
        if (prev.some((m) => m.id === contact._id)) return prev
        return [
          ...prev,
          { id: contact._id, displayText: `@${contact.displayName}` },
        ]
      })
    },
    []
  )

  // Create transport (only when appUrl is available)
  const chatTransport = React.useMemo(() => {
    if (!appUrl) return null
    return new DefaultChatTransport({
      api: `${appUrl}/api/chat`,
      fetch: async (url, options) => {
        // Get token from electron
        const token = await electron.config.getAccessToken()
        const tracked = trackedMentionsRef.current
        const headers = {
          ...options?.headers,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        }

        // Inject mentioned contact IDs into the request body
        const activeContactIds = tracked.map((m) => m.id)
        let body = options?.body
        if (body && activeContactIds.length > 0) {
          try {
            const parsed = JSON.parse(body as string)
            parsed.mentionedContactIds = activeContactIds
            body = JSON.stringify(parsed)
          } catch (error) {
            console.error("Failed to inject mentionedContactIds:", error)
          }
        }

        return fetch(url, { ...options, body, headers })
      },
    })
  }, [appUrl, electron])

  return (
    <>
      {/* List Panel */}
      <Panel variant="shrink" width={320} position="first">
        <PanelHeader title="Chats" />

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {chats.map((chat) => (
            <ChatListItemRow
              key={chat.id}
              chat={chat}
              selected={selectedChatId === chat.id}
              onClick={() => {}}
            />
          ))}
        </div>
      </Panel>

      {/* Detail Panel */}
      <Panel position="last">
        <PanelHeader title="New Chat" />
        {chatTransport ? (
          <ChatPanel
            transport={chatTransport}
            searchContacts={searchContacts}
            onMentionInsert={handleMentionInsert}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Loading...
          </div>
        )}
      </Panel>
    </>
  )
}
