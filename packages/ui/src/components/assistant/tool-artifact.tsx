import * as React from "react"
import {
  CheckCircle2,
  Clock,
  Mail,
  MessageCircle,
  Search,
  User,
  Users,
} from "lucide-react"

import { cn } from "../../lib/utils"
import { Badge } from "../ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card"
import type {
  ActionResult,
  ContactResult,
  ConversationResult,
  MemoryResult,
  SearchResult,
  ToolArtifact as ToolArtifactType,
} from "./types"

function PlatformIcon({ platform }: { platform: string }) {
  if (platform === "gmail") {
    return <Mail className="size-3" />
  }
  return <MessageCircle className="size-3" />
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

function SearchResultsArtifact({ results }: { results: SearchResult[] }) {
  if (results.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Search className="size-4" />
        <span>No messages found</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Search className="size-3" />
        <span>{results.length} message{results.length !== 1 ? "s" : ""} found</span>
      </div>
      <div className="space-y-1.5">
        {results.slice(0, 5).map((result) => (
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
        {results.length > 5 && (
          <p className="text-xs text-muted-foreground">
            +{results.length - 5} more results
          </p>
        )}
      </div>
    </div>
  )
}

function ContactArtifact({ contact }: { contact: ContactResult }) {
  return (
    <Card className="py-4 shadow-none border-border/40 bg-card/50">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <User className="size-5" />
          </div>
          <div>
            <CardTitle className="text-base">{contact.displayName}</CardTitle>
            {contact.company && (
              <p className="text-sm text-muted-foreground">{contact.company}</p>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {contact.handles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {contact.handles.map((handle, i) => (
              <Badge key={i} variant="outline" className="text-xs">
                <PlatformIcon platform={handle.platform} />
                <span className="ml-1">{handle.handle}</span>
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ContactsArtifact({ contacts }: { contacts: ContactResult[] }) {
  if (contacts.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Users className="size-4" />
        <span>No contacts found</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Users className="size-3" />
        <span>{contacts.length} contact{contacts.length !== 1 ? "s" : ""} found</span>
      </div>
      <div className="space-y-1.5">
        {contacts.map((contact) => (
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
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ConversationsArtifact({
  conversations,
}: {
  conversations: ConversationResult[]
}) {
  if (conversations.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <MessageCircle className="size-4" />
        <span>No conversations found</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <MessageCircle className="size-3" />
        <span>{conversations.length} conversation{conversations.length !== 1 ? "s" : ""}</span>
      </div>
      <div className="space-y-1.5">
        {conversations.slice(0, 5).map((conv) => (
          <div
            key={conv._id}
            className="flex items-start gap-2 rounded-lg border border-border/40 bg-card/30 p-2.5"
          >
            <PlatformIcon platform={conv.platform} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  {conv.participantNames.slice(0, 2).join(", ")}
                  {conv.participantNames.length > 2 && ` +${conv.participantNames.length - 2}`}
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
        ))}
      </div>
    </div>
  )
}

function ActionCreatedArtifact({ action }: { action: ActionResult }) {
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
          {action.type.replace("_", " ")} - Priority {action.priority}
        </p>
        {action.reason && (
          <p className="mt-1 text-sm text-foreground/80">{action.reason}</p>
        )}
        {action.draftMessage && (
          <div className="mt-2 rounded-md bg-background/50 p-2 text-sm">
            {action.draftMessage}
          </div>
        )}
      </div>
    </div>
  )
}

function MemoriesArtifact({ memories }: { memories: MemoryResult[] }) {
  if (memories.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Clock className="size-4" />
        <span>No memories found</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Clock className="size-3" />
        <span>{memories.length} memor{memories.length !== 1 ? "ies" : "y"} recalled</span>
      </div>
      <div className="space-y-1.5">
        {memories.map((memory) => (
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
    </div>
  )
}

interface ToolArtifactProps {
  artifact: ToolArtifactType
  className?: string
}

function renderArtifact(artifact: ToolArtifactType) {
  switch (artifact.type) {
    case "search_results":
      return <SearchResultsArtifact results={artifact.data} />
    case "contact":
      return <ContactArtifact contact={artifact.data} />
    case "contacts":
      return <ContactsArtifact contacts={artifact.data} />
    case "conversations":
      return <ConversationsArtifact conversations={artifact.data} />
    case "action_created":
      return <ActionCreatedArtifact action={artifact.data} />
    case "memories":
      return <MemoriesArtifact memories={artifact.data} />
  }
}

export function ToolArtifact({ artifact, className }: ToolArtifactProps) {
  return <div className={cn("mt-3", className)}>{renderArtifact(artifact)}</div>
}
