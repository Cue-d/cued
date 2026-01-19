"use client"

import { Copy, User, Users } from "lucide-react"
import { toast } from "sonner"
import { Artifact } from "./create-artifact"
import { PlatformIcon } from "./utils"
import { Badge } from "../../ui/badge"

export interface ContactResult {
  _id: string
  displayName: string
  company?: string | null
  handles: Array<{
    type: string
    value: string
    platform: string
  }>
}

function ContactsContent({ data }: { data: ContactResult[] }) {
  if (data.length === 0) {
    return null
  }

  return (
    <div className="space-y-1.5">
      {data.map((contact) => (
        <div
          key={contact._id}
          className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/30 p-2.5"
        >
          <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
            <User className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{contact.displayName}</p>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
            {contact.handles.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {contact.handles.slice(0, 3).map((handle, i) => (
                  <Badge key={i} variant="outline" className="text-[10px]">
                    <PlatformIcon platform={handle.platform} />
                    <span className="ml-1 truncate max-w-[120px]">
                      {handle.value}
                    </span>
                  </Badge>
                ))}
                {contact.handles.length > 3 && (
                  <Badge variant="outline" className="text-[10px]">
                    +{contact.handles.length - 3}
                  </Badge>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

export const contactsArtifact = new Artifact<"search_contacts", ContactResult[]>(
  {
    kind: "search_contacts",
    description: "Contact search results",
    icon: Users,
    emptyMessage: "No contacts found",
    parse: (result) => {
      if (!result || typeof result !== "object") return null
      const data = result as Record<string, unknown>
      if (Array.isArray(data.results)) {
        return data.results as ContactResult[]
      }
      return null
    },
    content: ContactsContent,
    actions: [
      {
        icon: <Copy className="size-3.5" />,
        description: "Copy contacts",
        onClick: ({ data }) => {
          const text = data
            .map((c) => {
              const handles = c.handles.map((h) => h.value).join(", ")
              return `${c.displayName}${c.company ? ` (${c.company})` : ""}: ${handles}`
            })
            .join("\n")
          navigator.clipboard.writeText(text)
          toast.success("Copied to clipboard")
        },
        isDisabled: ({ data }) => data.length === 0,
      },
    ],
  }
)
