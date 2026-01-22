"use client"

import { Clock, Copy } from "lucide-react"
import { toast } from "sonner"
import { Artifact } from "./create-artifact"

export interface MemoryResult {
  id: string
  memory: string
  created_at?: string
}

function MemoriesContent({ data }: { data: MemoryResult[] }) {
  if (data.length === 0) {
    return null
  }

  return (
    <div className="space-y-1.5">
      {data.map((memory) => (
        <div
          key={memory.id}
          className="rounded-lg border border-border/40 bg-card/30 p-2.5"
        >
          <p className="text-sm text-foreground/90">{memory.memory}</p>
          {memory.created_at && (
            <p className="mt-1 text-xs text-muted-foreground/60">
              {new Date(memory.created_at).toLocaleDateString()}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

export const memoriesArtifact = new Artifact<"search_memories", MemoryResult[]>({
  kind: "search_memories",
  description: "Memories recalled from past conversations",
  icon: Clock,
  emptyMessage: "No memories found",
  parse: (result) => {
    if (!result || typeof result !== "object") return null
    const data = result as Record<string, unknown>
    // Support both 'results' (new standard) and 'memories' (legacy)
    if (Array.isArray(data.results)) {
      return data.results as MemoryResult[]
    }
    if (Array.isArray(data.memories)) {
      return data.memories as MemoryResult[]
    }
    return null
  },
  content: MemoriesContent,
  actions: [
    {
      icon: <Copy className="size-3.5" />,
      description: "Copy memories",
      onClick: ({ data }) => {
        const text = data.map((m) => m.memory).join("\n\n")
        navigator.clipboard.writeText(text)
        toast.success("Copied to clipboard")
      },
      isDisabled: ({ data }) => data.length === 0,
    },
  ],
})
