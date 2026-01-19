"use client"

import { Copy, ListTodo } from "lucide-react"
import { toast } from "sonner"

import { cn } from "../../../lib/utils"
import { Badge } from "../../ui/badge"
import { Artifact } from "./create-artifact"
import { formatActionType, formatRelativeTime, PlatformIcon } from "./utils"

export interface ActionSearchResult {
  _id: string
  type: string
  status: string
  priority: number
  contactName: string | null
  reason: string | null
  createdAt: number
  snoozedUntil: number | null
  platform: string | null
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    pending: "bg-amber-500/10 text-amber-600 border-amber-500/20",
    completed: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
    discarded: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
    snoozed: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  }

  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] capitalize", variants[status] || "")}
    >
      {status}
    </Badge>
  )
}

function ActionsContent({ data }: { data: ActionSearchResult[] }) {
  if (data.length === 0) {
    return null
  }

  return (
    <div className="space-y-1.5">
      {data.slice(0, 5).map((action) => (
        <div
          key={action._id}
          className="flex items-start gap-2 rounded-lg border border-border/40 bg-card/30 p-2.5"
        >
          {action.platform && (
            <div className="shrink-0 pt-0.5">
              <PlatformIcon platform={action.platform} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground/90">
                {formatActionType(action.type)}
              </span>
              <StatusBadge status={action.status} />
              <span className="text-xs text-muted-foreground/60">
                {formatRelativeTime(action.createdAt)}
              </span>
            </div>
            {action.contactName && (
              <p className="mt-0.5 text-sm text-foreground/80">
                {action.contactName}
              </p>
            )}
            {action.reason && (
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                {action.reason}
              </p>
            )}
          </div>
        </div>
      ))}
      {data.length > 5 && (
        <p className="text-xs text-muted-foreground">
          +{data.length - 5} more actions
        </p>
      )}
    </div>
  )
}

export const actionsArtifact = new Artifact<
  "search_actions",
  ActionSearchResult[]
>({
  kind: "search_actions",
  description: "Actions from the action queue",
  icon: ListTodo,
  emptyMessage: "No actions found",
  parse: (result) => {
    if (!result || typeof result !== "object") return null
    const data = result as Record<string, unknown>
    if (Array.isArray(data.actions)) {
      return data.actions as ActionSearchResult[]
    }
    return null
  },
  content: ActionsContent,
  actions: [
    {
      icon: <Copy className="size-3.5" />,
      description: "Copy actions",
      onClick: ({ data }) => {
        const text = data
          .map((a) => {
            const parts = [formatActionType(a.type), `[${a.status}]`]
            if (a.contactName) parts.push(a.contactName)
            if (a.reason) parts.push(`- ${a.reason}`)
            return parts.join(" ")
          })
          .join("\n")
        navigator.clipboard.writeText(text)
        toast.success("Copied to clipboard")
      },
      isDisabled: ({ data }) => data.length === 0,
    },
  ],
})
