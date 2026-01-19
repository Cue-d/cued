"use client"

import { Copy, MessageCircle } from "lucide-react"
import { toast } from "sonner"
import { Artifact } from "./create-artifact"
import { formatRelativeTime, PlatformIcon } from "./utils"

export interface ConversationResult {
  _id: string
  platform: string
  conversationType: string
  participants: Array<{ _id: string; displayName: string }>
  lastMessageText?: string | null
  lastMessageAt?: number | null
}

function ConversationsContent({ data }: { data: ConversationResult[] }) {
  if (data.length === 0) {
    return null
  }

  return (
    <div className="space-y-1.5">
      {data.slice(0, 5).map((conv) => {
        const participantNames = conv.participants.map((p) => p.displayName)
        return (
          <div
            key={conv._id}
            className="flex items-start gap-2 rounded-lg border border-border/40 bg-card/30 p-2.5"
          >
            <PlatformIcon platform={conv.platform} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  {participantNames.slice(0, 2).join(", ")}
                  {participantNames.length > 2 &&
                    ` +${participantNames.length - 2}`}
                </span>
                {conv.lastMessageAt && (
                  <span className="text-xs text-muted-foreground/60">
                    {formatRelativeTime(conv.lastMessageAt)}
                  </span>
                )}
              </div>
              {conv.lastMessageText && (
                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                  {conv.lastMessageText}
                </p>
              )}
            </div>
          </div>
        )
      })}
      {data.length > 5 && (
        <p className="text-xs text-muted-foreground">
          +{data.length - 5} more conversations
        </p>
      )}
    </div>
  )
}

export const conversationsArtifact = new Artifact<
  "get_conversations",
  ConversationResult[]
>({
  kind: "get_conversations",
  description: "Recent conversations from inbox",
  icon: MessageCircle,
  emptyMessage: "No conversations found",
  parse: (result) => {
    if (!result || typeof result !== "object") return null
    const data = result as Record<string, unknown>
    if (Array.isArray(data.conversations)) {
      return data.conversations as ConversationResult[]
    }
    return null
  },
  content: ConversationsContent,
  actions: [
    {
      icon: <Copy className="size-3.5" />,
      description: "Copy conversations",
      onClick: ({ data }) => {
        const text = data
          .map((c) => {
            const participants = c.participants.map((p) => p.displayName).join(", ")
            return `${participants}: ${c.lastMessageText || "(no message)"}`
          })
          .join("\n")
        navigator.clipboard.writeText(text)
        toast.success("Copied to clipboard")
      },
      isDisabled: ({ data }) => data.length === 0,
    },
  ],
})
