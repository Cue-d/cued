"use client"

import { CheckCircle2 } from "lucide-react"
import { Artifact } from "./create-artifact"

export interface ActionResult {
  actionId: string
  type: string
  priority: number
  reason?: string
}

function ActionCreatedContent({ data }: { data: ActionResult }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
        <CheckCircle2 className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
          Action created
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {data.type.replace("_", " ")} - Priority {data.priority}
        </p>
        {data.reason && (
          <p className="mt-1 text-sm text-foreground/80">{data.reason}</p>
        )}
      </div>
    </div>
  )
}

export const actionCreatedArtifact = new Artifact<"create_action", ActionResult>(
  {
    kind: "create_action",
    description: "Confirmation that an action was created",
    icon: CheckCircle2,
    emptyMessage: "Action created",
    parse: (result) => {
      if (!result || typeof result !== "object") return null
      const data = result as Record<string, unknown>
      if (data.actionId) {
        return {
          actionId: data.actionId as string,
          type: (data.type as string) || "unknown",
          priority: (data.priority as number) || 50,
          reason: data.reason as string | undefined,
        }
      }
      return null
    },
    content: ActionCreatedContent,
  }
)
