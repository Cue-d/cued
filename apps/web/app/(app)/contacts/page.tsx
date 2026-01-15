"use client"

import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@prm/convex"
import type { Id } from "@prm/convex"
import {
  MergeCard,
  type MergeContact,
  type MergeSuggestion,
  type ContactHandle,
} from "@prm/ui"
import { Card, CardContent, Skeleton, Badge, Avatar, AvatarFallback } from "@prm/ui"
import { Mail, MessageSquare, Phone, AlertCircle, Users } from "lucide-react"

/** Get initials from a name */
function getInitials(name: string): string {
  if (/^\+?\d/.test(name)) return "#"
  if (name.includes("@")) return name[0].toUpperCase()
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

/** Handle icon by type */
function HandleIcon({ type }: { type: string }) {
  switch (type) {
    case "phone":
      return <Phone className="w-3 h-3 text-muted-foreground" />
    case "email":
      return <Mail className="w-3 h-3 text-muted-foreground" />
    case "slack_id":
      return <MessageSquare className="w-3 h-3 text-muted-foreground" />
    default:
      return null
  }
}

/** Contact row component */
function ContactRow({ contact }: { contact: { _id: Id<"contacts">; displayName: string; company?: string | null; handles: Array<{ type: string; value: string; platform: string }> } }) {
  const initials = getInitials(contact.displayName)

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors">
      <Avatar size="sm">
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{contact.displayName}</span>
          {contact.company && (
            <span className="text-xs text-muted-foreground truncate">• {contact.company}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2 mt-1">
          {contact.handles.slice(0, 3).map((handle, i) => (
            <div key={i} className="flex items-center gap-1 text-xs text-muted-foreground">
              <HandleIcon type={handle.type} />
              <span className="truncate max-w-[150px]">{handle.value}</span>
              <Badge variant="outline" className="text-[9px] px-1 py-0 h-4" style={{ fontSize: '9px' }}>
                {handle.platform}
              </Badge>
            </div>
          ))}
          {contact.handles.length > 3 && (
            <span className="text-xs text-muted-foreground">+{contact.handles.length - 3} more</span>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ContactsPage() {
  // Fetch pending merge suggestions
  const suggestionsResult = useQuery(api.contacts.getPendingMergeSuggestions, { limit: 10 })
  const suggestions = suggestionsResult?.suggestions ?? []
  const suggestionsLoading = suggestionsResult === undefined

  // Fetch contacts list
  const contactsResult = useQuery(api.contacts.getContacts, { limit: 50 })
  const contacts = contactsResult?.contacts ?? []
  const contactsLoading = contactsResult === undefined

  // Mutations
  const mergeContacts = useMutation(api.contacts.mergeContacts)
  const rejectMerge = useMutation(api.contacts.rejectMerge)

  // Track loading states for individual cards
  const [loadingStates, setLoadingStates] = React.useState<Record<string, boolean>>({})

  const handleMerge = React.useCallback(async (
    suggestionId: Id<"mergeSuggestions">,
    primaryId: Id<"contacts">,
    secondaryId: Id<"contacts">
  ) => {
    setLoadingStates(prev => ({ ...prev, [suggestionId]: true }))
    try {
      await mergeContacts({
        primaryContactId: primaryId,
        secondaryContactId: secondaryId,
        suggestionId,
      })
    } catch (error) {
      console.error("Failed to merge contacts:", error)
    } finally {
      setLoadingStates(prev => ({ ...prev, [suggestionId]: false }))
    }
  }, [mergeContacts])

  const handleReject = React.useCallback(async (suggestionId: Id<"mergeSuggestions">) => {
    setLoadingStates(prev => ({ ...prev, [suggestionId]: true }))
    try {
      await rejectMerge({ suggestionId })
    } catch (error) {
      console.error("Failed to reject merge:", error)
    } finally {
      setLoadingStates(prev => ({ ...prev, [suggestionId]: false }))
    }
  }, [rejectMerge])

  // Loading skeleton
  if (suggestionsLoading && contactsLoading) {
    return (
      <div className="h-full p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8">
      {/* Merge Suggestions Section */}
      {suggestions.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <AlertCircle className="w-5 h-5 text-amber-500" />
            <h2 className="text-lg font-semibold">Possible Duplicates</h2>
            <Badge variant="secondary" className="ml-2">{suggestions.length}</Badge>
          </div>
          <div className="grid gap-4 max-w-2xl">
            {suggestions.map((suggestion) => {
              if (!suggestion.contact1 || !suggestion.contact2) return null

              const contact1: MergeContact = {
                _id: suggestion.contact1._id,
                displayName: suggestion.contact1.displayName,
                company: suggestion.contact1.company,
                notes: suggestion.contact1.notes,
                handles: suggestion.contact1.handles as ContactHandle[],
              }

              const contact2: MergeContact = {
                _id: suggestion.contact2._id,
                displayName: suggestion.contact2.displayName,
                company: suggestion.contact2.company,
                notes: suggestion.contact2.notes,
                handles: suggestion.contact2.handles as ContactHandle[],
              }

              const mergeSuggestion: MergeSuggestion = {
                _id: suggestion._id,
                confidence: suggestion.confidence,
                source: suggestion.source as MergeSuggestion["source"],
                reasoning: suggestion.reasoning,
              }

              return (
                <MergeCard
                  key={suggestion._id}
                  contact1={contact1}
                  contact2={contact2}
                  suggestion={mergeSuggestion}
                  onMerge={() => handleMerge(suggestion._id, suggestion.contact1Id, suggestion.contact2Id)}
                  onReject={() => handleReject(suggestion._id)}
                  isLoading={loadingStates[suggestion._id] ?? false}
                />
              )
            })}
          </div>
        </section>
      )}

      {/* All Contacts Section */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Users className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">All Contacts</h2>
          <Badge variant="secondary" className="ml-2">{contacts.length}</Badge>
        </div>

        {contacts.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No contacts yet. Connect Gmail or iMessage to import contacts.</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-2 divide-y">
              {contacts.map((contact) => (
                <ContactRow key={contact._id} contact={contact} />
              ))}
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  )
}
