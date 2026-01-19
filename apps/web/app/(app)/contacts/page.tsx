"use client"

import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@prm/convex"
import type { Id } from "@prm/convex"
import { getInitials } from "@prm/shared"
import {
  MergeCard,
  type MergeContact,
  type MergeSuggestion,
  type ContactHandle,
} from "@prm/ui"
import { Card, CardContent, Skeleton, Badge, Avatar, AvatarFallback, Input, Button } from "@prm/ui"
import { Mail, MessageSquare, Phone, AlertCircle, Users, Search, Loader2, ChevronDown, ScanSearch } from "lucide-react"

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

/** Normalize phone number to just digits for comparison */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "")
  // Remove leading 1 for US numbers if 11 digits
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1)
  }
  return digits
}

/** Deduplicate handles, merging phone variations */
function deduplicateHandles(handles: Array<{ type: string; value: string; platform: string }>) {
  const seen = new Map<string, { type: string; value: string; platform: string }>()

  for (const handle of handles) {
    let key: string
    let displayValue = handle.value

    if (handle.type === "phone") {
      // Normalize phone for deduplication
      key = `phone:${normalizePhone(handle.value)}`
      // Prefer the formatted version with + prefix
      if (seen.has(key)) {
        const existing = seen.get(key)!
        if (handle.value.startsWith("+") && !existing.value.startsWith("+")) {
          // Current has +, existing doesn't - keep current
          displayValue = handle.value
        } else {
          continue // Skip this duplicate
        }
      }
    } else {
      key = `${handle.type}:${handle.value.toLowerCase()}`
    }

    seen.set(key, { ...handle, value: displayValue })
  }

  return Array.from(seen.values())
}

/** Contact row component */
function ContactRow({ contact }: { contact: { _id: Id<"contacts">; displayName: string; company?: string | null; handles: Array<{ type: string; value: string; platform: string }> } }) {
  const initials = getInitials(contact.displayName)
  const uniqueHandles = deduplicateHandles(contact.handles)

  // Group handles by type for cleaner display
  const phones = uniqueHandles.filter(h => h.type === "phone")
  const emails = uniqueHandles.filter(h => h.type === "email")
  const other = uniqueHandles.filter(h => h.type !== "phone" && h.type !== "email")

  // Show up to 4 handles total, prioritizing variety
  const displayHandles: Array<{ type: string; value: string; platform: string }> = []
  if (phones[0]) displayHandles.push(phones[0])
  if (emails[0]) displayHandles.push(emails[0])
  if (phones[1]) displayHandles.push(phones[1])
  if (emails[1]) displayHandles.push(emails[1])
  displayHandles.push(...other)
  const shown = displayHandles.slice(0, 4)
  const remaining = uniqueHandles.length - shown.length

  return (
    <div className="flex items-start gap-3 p-3 hover:bg-muted/50">
      <Avatar size="sm">
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{contact.displayName}</span>
          {contact.company && (
            <span className="text-xs text-muted-foreground">• {contact.company}</span>
          )}
        </div>
        {shown.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs text-muted-foreground">
            {shown.map((handle, i) => (
              <span key={i} className="flex items-center gap-1.5">
                <HandleIcon type={handle.type} />
                <span>{handle.value}</span>
              </span>
            ))}
            {remaining > 0 && (
              <span className="text-muted-foreground/60">+{remaining} more</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Debounce hook for search */
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = React.useState(value)

  React.useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(handler)
  }, [value, delay])

  return debouncedValue
}

export default function ContactsPage() {
  // Search state
  const [searchInput, setSearchInput] = React.useState("")
  const debouncedSearch = useDebounce(searchInput, 300)

  // Pagination state
  const [cursor, setCursor] = React.useState<Id<"contacts"> | undefined>(undefined)
  const [allContacts, setAllContacts] = React.useState<Array<{
    _id: Id<"contacts">
    displayName: string
    company?: string | null
    handles: Array<{ type: string; value: string; platform: string }>
  }>>([])
  const [isLoadingMore, setIsLoadingMore] = React.useState(false)

  // Reset pagination when search changes
  React.useEffect(() => {
    setCursor(undefined)
    setAllContacts([])
  }, [debouncedSearch])

  // Fetch pending merge suggestions
  const suggestionsResult = useQuery(api.contacts.getPendingMergeSuggestions, { limit: 10 })
  const suggestions = suggestionsResult?.suggestions ?? []
  const suggestionsLoading = suggestionsResult === undefined

  // Fetch contacts list with search and pagination
  const contactsResult = useQuery(api.contacts.getContacts, {
    limit: 50,
    cursor,
    searchQuery: debouncedSearch || undefined,
  })
  const contactsLoading = contactsResult === undefined
  const totalCount = allContacts.length
  const hasMore = contactsResult?.nextCursor !== null && contactsResult?.nextCursor !== undefined

  // Accumulate contacts for pagination
  React.useEffect(() => {
    if (contactsResult?.contacts) {
      if (cursor === undefined) {
        // First load or search changed - replace all
        setAllContacts(contactsResult.contacts)
      } else {
        // Loading more - append
        setAllContacts((prev) => {
          const existingIds = new Set(prev.map((c) => c._id))
          const newContacts = contactsResult.contacts.filter((c) => !existingIds.has(c._id))
          return [...prev, ...newContacts]
        })
      }
      setIsLoadingMore(false)
    }
  }, [contactsResult, cursor])

  const handleLoadMore = React.useCallback(() => {
    if (contactsResult?.nextCursor && !isLoadingMore) {
      setIsLoadingMore(true)
      setCursor(contactsResult.nextCursor)
    }
  }, [contactsResult?.nextCursor, isLoadingMore])

  // Mutations
  const mergeContacts = useMutation(api.contacts.mergeContacts)
  const rejectMerge = useMutation(api.contacts.rejectMerge)
  const triggerMergeScan = useMutation(api.contactResolution.triggerMergeScan)

  // Track loading states for individual cards
  const [loadingStates, setLoadingStates] = React.useState<Record<string, boolean>>({})
  const [isScanning, setIsScanning] = React.useState(false)

  const handleTriggerScan = React.useCallback(async () => {
    setIsScanning(true)
    try {
      await triggerMergeScan({})
    } catch (error) {
      console.error("Failed to trigger merge scan:", error)
    } finally {
      // Keep scanning state for a bit to show feedback
      setTimeout(() => setIsScanning(false), 2000)
    }
  }, [triggerMergeScan])

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
  if (suggestionsLoading && contactsLoading && allContacts.length === 0) {
    return (
      <div className="h-full p-6 space-y-6">
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    )
  }

  const displayContacts = allContacts.length > 0 ? allContacts : (contactsResult?.contacts ?? [])

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8">
      {/* Search Bar and Actions */}
      <div className="sticky -top-6 z-10 bg-background pb-4 -mx-6 px-6 pt-6">
        <div className="flex items-center gap-3 max-w-2xl">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search contacts..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9 pr-4"
            />
            {contactsLoading && debouncedSearch && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
            )}
          </div>
          <Button
            variant="outline"
            onClick={handleTriggerScan}
            disabled={isScanning}
            className="gap-2 shrink-0"
          >
            {isScanning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Scanning...
              </>
            ) : (
              <>
                <ScanSearch className="w-4 h-4" />
                Find Duplicates
              </>
            )}
          </Button>
        </div>
      </div>

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
          <Badge variant="secondary" className="ml-2">
            {debouncedSearch ? `${displayContacts.length} of ${totalCount}` : totalCount}
          </Badge>
        </div>

        {displayContacts.length === 0 && !contactsLoading ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
              {debouncedSearch ? (
                <p>No contacts matching &quot;{debouncedSearch}&quot;</p>
              ) : (
                <p>No contacts yet. Connect Gmail or iMessage to import contacts.</p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-2 divide-y divide-border">
              {displayContacts.map((contact) => (
                <ContactRow key={contact._id} contact={contact} />
              ))}
            </CardContent>
            {/* Load More Button */}
            {hasMore && !debouncedSearch && (
              <div className="p-4 flex justify-center">
                <Button
                  variant="outline"
                  onClick={handleLoadMore}
                  disabled={isLoadingMore}
                  className="gap-2"
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    <>
                      <ChevronDown className="w-4 h-4" />
                      Load More
                    </>
                  )}
                </Button>
              </div>
            )}
          </Card>
        )}
      </section>
    </div>
  )
}
