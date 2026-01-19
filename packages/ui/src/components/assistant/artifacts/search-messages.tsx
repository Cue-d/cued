"use client"

import { Copy, Search } from "lucide-react"
import { toast } from "sonner"
import { Artifact } from "./create-artifact"
import { formatRelativeTime, PlatformIcon } from "./utils"

export interface SearchResult {
  _id: string
  content: string
  sentAt: number
  conversationId: string
  platform: string
  isFromMe: boolean
  senderName?: string
}

function SearchMessagesContent({ data }: { data: SearchResult[] }) {
  return (
    <div className="space-y-1.5">
      {data.slice(0, 5).map((result) => (
        <div
          key={result._id}
          className="group flex items-start gap-2 rounded-lg border border-border/40 bg-card/30 p-2.5 transition-colors hover:bg-card/60"
        >
          <div className="shrink-0 pt-0.5">
            <PlatformIcon platform={result.platform} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground/70">
                {result.isFromMe ? "You" : result.senderName || "Unknown"}
              </span>
              <span className="text-xs text-muted-foreground/60">
                {formatRelativeTime(result.sentAt)}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-sm text-foreground/90">
              {result.content}
            </p>
          </div>
        </div>
      ))}
      {data.length > 5 && (
        <p className="text-xs text-muted-foreground">
          +{data.length - 5} more results
        </p>
      )}
    </div>
  )
}

export const searchMessagesArtifact = new Artifact<
  "search_messages",
  SearchResult[]
>({
  kind: "search_messages",
  description: "Search results from message history",
  icon: Search,
  emptyMessage: "No messages found",
  parse: (result) => {
    if (!result || typeof result !== "object") return null
    const data = result as Record<string, unknown>
    if (Array.isArray(data.results)) {
      return data.results as SearchResult[]
    }
    return null
  },
  content: SearchMessagesContent,
  actions: [
    {
      icon: <Copy className="size-3.5" />,
      description: "Copy messages",
      onClick: ({ data }) => {
        const text = data
          .map(
            (r) =>
              `${r.isFromMe ? "You" : r.senderName || "Unknown"}: ${r.content}`
          )
          .join("\n\n")
        navigator.clipboard.writeText(text)
        toast.success("Copied to clipboard")
      },
      isDisabled: ({ data }) => data.length === 0,
    },
  ],
})
