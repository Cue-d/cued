"use client"

import { useState } from "react"
import { useQuery } from "convex/react"
import { api } from "@prm/convex"
import { ConversationList, type Conversation } from "@prm/ui"

export default function InboxPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const inboxResult = useQuery(api.messages.getInbox, { limit: 50 })
  const conversations = (inboxResult?.conversations ?? []) as Conversation[]
  const loading = inboxResult === undefined

  return (
    <div className="flex h-full">
      <ConversationList
        conversations={conversations}
        selectedId={selectedId}
        onSelect={setSelectedId}
        loading={loading}
        hasMore={!!inboxResult?.nextCursor}
      />

      <div className="flex-1 flex items-center justify-center bg-muted/30">
        {selectedId ? (
          <div className="text-muted-foreground">
            <p>Conversation detail view coming soon</p>
            <p className="text-xs mt-1">Selected: {selectedId}</p>
          </div>
        ) : (
          <p className="text-muted-foreground">Select a conversation to view messages</p>
        )}
      </div>
    </div>
  )
}
