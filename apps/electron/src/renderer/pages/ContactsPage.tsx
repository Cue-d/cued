import * as React from "react"
import { useMutation, useQuery } from "convex/react"
import { Users, Search, Loader2 } from 'lucide-react'
import { AnimatePresence } from "motion/react"
import { api } from "@cued/convex"
import { type ActionPlatform } from "@cued/shared"
import {
  EmptyState,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@cued/ui"
import { ActionFilterDropdown, type ActionFilterDropdownRef } from "../components/action-filter-dropdown"
import { Skeleton, Input } from "@cued/ui"
import type { Id } from "@cued/convex"
import { Panel, PanelHeader } from "../components/app-shell"
import { ContactDetail } from "../components/contacts/ContactDetail"
import { SwipeableContactListItem } from "../components/SwipeableContactListItem"
import { toast } from "sonner"

/** Returns true if the display name looks like an actual person name (not a phone/ID/email) */
function isRealContactName(displayName: string): boolean {
  const trimmed = displayName.trim()
  if (!trimmed) return false
  if (/^[\d+\-(). ]+$/.test(trimmed)) return false
  if (/^[UW][A-Z0-9]{8,}$/i.test(trimmed)) return false
  if (trimmed.startsWith("urn:li:")) return false
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false
  return true
}

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = React.useState(value)

  React.useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(handler)
  }, [value, delay])

  return debouncedValue
}

type ContactCursor = { displayName: string; _id: Id<"contacts"> }

type ContactListItem = {
  _id: Id<"contacts">
  displayName: string
  company?: string | null
  avatarUrl?: string | null
  handles: Array<{ type: string; value: string; platform: string }>
}

interface ContactsPageProps {
  initialContactId?: string | null
  onInitialContactConsumed?: () => void
}

type PendingRareContactAction = {
  type: "archive"
  contactId: Id<"contacts">
  contactName: string
}

export function ContactsPage({ initialContactId, onInitialContactConsumed }: ContactsPageProps): React.JSX.Element {
  const [selectedContactId, setSelectedContactId] = React.useState<Id<"contacts"> | null>(null)

  // Navigate to initial contact when provided
  React.useEffect(() => {
    if (initialContactId) {
      setSelectedContactId(initialContactId as Id<"contacts">)
      onInitialContactConsumed?.()
    }
  }, [initialContactId, onInitialContactConsumed])

  const [searchInput, setSearchInput] = React.useState("")
  const debouncedSearch = useDebounce(searchInput, 300)

  // Platform filter state
  const filterRef = React.useRef<ActionFilterDropdownRef>(null)
  const [activePlatforms, setActivePlatforms] = React.useState<Set<ActionPlatform>>(new Set())
  const [namedOnly, setNamedOnly] = React.useState(true)
  const [statusFilter, setStatusFilter] = React.useState<"active" | "archived">("active")

  const [cursor, setCursor] = React.useState<ContactCursor | undefined>(undefined)
  const [allContacts, setAllContacts] = React.useState<ContactListItem[]>([])
  const [isLoadingMore, setIsLoadingMore] = React.useState(false)
  const autoLoadAttemptsRef = React.useRef(0)

  const [openSwipeItemId, setOpenSwipeItemId] = React.useState<string | null>(null)
  const [pendingRareAction, setPendingRareAction] = React.useState<PendingRareContactAction | null>(null)
  const [isApplyingRareAction, setIsApplyingRareAction] = React.useState(false)
  const setContactStatusMut = useMutation(api.contacts.setContactStatus)

  const listContainerRef = React.useRef<HTMLDivElement>(null)
  const loadMoreRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    setCursor(undefined)
    setAllContacts([])
  }, [debouncedSearch, namedOnly, statusFilter])

  const contactsResult = useQuery(api.contacts.getContacts, {
    limit: 50,
    cursor,
    searchQuery: debouncedSearch || undefined,
    status: statusFilter,
    namedOnly,
  })
  const contactsLoading = contactsResult === undefined
  const nextCursor = contactsResult?.nextCursor
  const hasMore =
    nextCursor !== null &&
    nextCursor !== undefined

  const loadNextPage = React.useCallback(() => {
    if (!nextCursor || isLoadingMore || debouncedSearch) return
    setIsLoadingMore(true)
    setCursor(nextCursor)
  }, [nextCursor, isLoadingMore, debouncedSearch])

  React.useEffect(() => {
    if (contactsResult?.contacts) {
      if (cursor === undefined) {
        setAllContacts(contactsResult.contacts)
      } else {
        setAllContacts((prev) => {
          const existingIds = new Set(prev.map((c) => c._id))
          const newContacts = contactsResult.contacts.filter(
            (c) => !existingIds.has(c._id)
          )
          return [...prev, ...newContacts]
        })
      }
      setIsLoadingMore(false)
    }
  }, [contactsResult, cursor])

  React.useEffect(() => {
    const sentinel = loadMoreRef.current
    const root = listContainerRef.current
    if (!sentinel || !root || !hasMore || debouncedSearch) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry?.isIntersecting) {
          loadNextPage()
        }
      },
      {
        root,
        rootMargin: "120px 0px",
      }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, debouncedSearch, loadNextPage])

  // Fallback for environments where IntersectionObserver events can be flaky.
  React.useEffect(() => {
    const list = listContainerRef.current
    if (!list || !hasMore || debouncedSearch) return

    const onScroll = () => {
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
      if (distanceFromBottom <= 120) {
        loadNextPage()
      }
    }

    list.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => list.removeEventListener("scroll", onScroll)
  }, [hasMore, debouncedSearch, loadNextPage, allContacts.length])

  const rawDisplayContacts = React.useMemo(
    () => (allContacts.length > 0 ? allContacts : contactsResult?.contacts ?? []),
    [allContacts, contactsResult?.contacts]
  )

  const displayContacts = React.useMemo(() => {
    let contacts = rawDisplayContacts
    if (namedOnly) {
      contacts = contacts.filter((c) => isRealContactName(c.displayName))
    }
    if (activePlatforms.size > 0) {
      contacts = contacts.filter((c) =>
        c.handles.some((h) => activePlatforms.has(h.platform as ActionPlatform))
      )
    }
    return contacts
  }, [rawDisplayContacts, activePlatforms, namedOnly])

  const visibleContacts = displayContacts
  const visibleContactsById = React.useMemo(
    () => new Map(visibleContacts.map((contact) => [contact._id, contact])),
    [visibleContacts]
  )

  // Auto-load more pages when client-side filters leave too few visible contacts
  // (e.g. phone-number contacts sort first alphabetically and get filtered out)
  // Cap at 5 consecutive auto-loads to prevent runaway queries.
  React.useEffect(() => {
    if (
      displayContacts.length < 10 &&
      nextCursor &&
      !isLoadingMore &&
      !debouncedSearch &&
      autoLoadAttemptsRef.current < 5
    ) {
      autoLoadAttemptsRef.current++
      loadNextPage()
    }
  }, [displayContacts.length, nextCursor, isLoadingMore, debouncedSearch, loadNextPage])

  // Reset auto-load counter when filters change
  React.useEffect(() => {
    autoLoadAttemptsRef.current = 0
  }, [activePlatforms, namedOnly, debouncedSearch, statusFilter])

  const selectedIndexRef = React.useRef(0)
  React.useEffect(() => {
    if (selectedContactId) {
      const idx = visibleContacts.findIndex((c) => c._id === selectedContactId)
      if (idx !== -1) selectedIndexRef.current = idx
    }
  }, [selectedContactId, visibleContacts])

  React.useEffect(() => {
    if (selectedContactId && !visibleContacts.find((c) => c._id === selectedContactId)) {
      if (visibleContacts.length === 0) {
        setSelectedContactId(null)
        return
      }
      const nextIndex = Math.min(selectedIndexRef.current, visibleContacts.length - 1)
      setSelectedContactId(visibleContacts[nextIndex]._id)
    }
  }, [visibleContacts, selectedContactId])

  React.useEffect(() => {
    if (!openSwipeItemId) return
    if (!visibleContacts.some((c) => c._id === openSwipeItemId)) {
      setOpenSwipeItemId(null)
    }
  }, [visibleContacts, openSwipeItemId])

  const requestRareAction = React.useCallback(
    (type: "archive", contactId: Id<"contacts">) => {
      const contact = visibleContactsById.get(contactId)
      if (!contact) return
      setOpenSwipeItemId(null)
      setPendingRareAction({
        type,
        contactId,
        contactName: contact.displayName,
      })
    },
    [visibleContactsById]
  )

  const handleConfirmRareAction = React.useCallback(async () => {
    if (!pendingRareAction || isApplyingRareAction) return

    setIsApplyingRareAction(true)
    try {
      await setContactStatusMut({
        contactId: pendingRareAction.contactId,
        status: "archived",
      })
      toast.success(`${pendingRareAction.contactName} archived`)
    } catch {
      toast.error("Failed to archive contact")
    } finally {
      setIsApplyingRareAction(false)
      setPendingRareAction(null)
    }
  }, [pendingRareAction, isApplyingRareAction, setContactStatusMut])

  const selectContact = React.useCallback((contactId: Id<"contacts">) => {
    setSelectedContactId(contactId)
    document.querySelector(`[data-swipe-item-id="${contactId}"]`)?.scrollIntoView({ block: "nearest" })
  }, [])

  const filteredCount = visibleContacts.length

  // Compute platform counts from all contacts
  const platformCounts = React.useMemo(() => {
    const counts: Partial<Record<ActionPlatform, number>> = {}
    for (const contact of rawDisplayContacts) {
      const platforms = new Set(contact.handles.map((h) => h.platform))
      for (const p of platforms) {
        const ap = p as ActionPlatform
        counts[ap] = (counts[ap] ?? 0) + 1
      }
    }
    return counts
  }, [rawDisplayContacts])

  // Keyboard navigation
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      if (e.key === "ArrowRight" && selectedContactId) {
        e.preventDefault()
        requestRareAction("archive", selectedContactId)
      } else if (e.key === "ArrowUp" && visibleContacts.length > 0) {
        e.preventDefault()
        const currentIndex = visibleContacts.findIndex(
          (c) => c._id === selectedContactId
        )
        if (currentIndex > 0) {
          selectContact(visibleContacts[currentIndex - 1]._id)
        }
      } else if (e.key === "ArrowDown" && visibleContacts.length > 0) {
        e.preventDefault()
        const currentIndex = visibleContacts.findIndex(
          (c) => c._id === selectedContactId
        )
        if (currentIndex < visibleContacts.length - 1) {
          selectContact(visibleContacts[currentIndex + 1]._id)
        } else if (currentIndex === -1) {
          selectContact(visibleContacts[0]._id)
        }
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault()
        filterRef.current?.open()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [selectedContactId, visibleContacts, selectContact, requestRareAction])

  // Loading skeleton (only on initial load, not when searching)
  if (contactsLoading && allContacts.length === 0 && !searchInput) {
    return (
      <>
        <Panel variant="shrink" width={320} position="first">
          <PanelHeader title="Contacts" />
          <div className="p-3 space-y-2">
            <Skeleton className="h-10 w-full mb-3" />
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        </Panel>
        <Panel position="last" className="p-6 space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </Panel>
      </>
    )
  }

  return (
    <>
      {/* List Panel */}
      <Panel variant="shrink" width={320} position="first">
        <PanelHeader title="Contacts">
          <ActionFilterDropdown
            ref={filterRef}
            counts={{}}
            total={filteredCount}
            activeFilter="all"
            onFilterChange={() => {}}
            platformCounts={platformCounts}
            activePlatforms={activePlatforms}
            filteredCount={filteredCount}
            onPlatformToggle={(platform) => {
              setActivePlatforms((prev) => {
                const next = new Set(prev)
                if (next.has(platform)) {
                  next.delete(platform)
                } else {
                  next.add(platform)
                }
                return next
              })
            }}
            toggles={[
              {
                label: "Named contacts only",
                active: namedOnly,
                onToggle: () => setNamedOnly((prev) => !prev),
              },
            ]}
          />
        </PanelHeader>

        {/* Search */}
        <div className="px-3 py-2">
          <div className="relative">
            <Search size={16} strokeWidth={1.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search people..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9 pr-4"
            />
            {contactsLoading && debouncedSearch && (
              <Loader2 size={16} strokeWidth={1.5} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin" />
            )}
          </div>
        </div>

        {/* Status Filter */}
        <div className="flex gap-1 px-3 pb-2">
          {(["active", "archived"] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                statusFilter === status
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-foreground/5"
              }`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>

        {/* Contact List */}
        <div ref={listContainerRef} className="flex-1 overflow-y-auto p-2">
          {visibleContacts.length === 0 ? (
            <EmptyState
              icon={<Users size={24} strokeWidth={1.5} className="text-muted-foreground" />}
              title={debouncedSearch ? `No results for "${debouncedSearch}"` : activePlatforms.size > 0 ? "No contacts on this platform" : "No contacts yet"}
              description={!debouncedSearch && activePlatforms.size === 0 ? "Connect iMessage to import contacts." : undefined}
              className="py-12"
            />
          ) : (
            <>
              <AnimatePresence mode="popLayout">
                {visibleContacts.map((contact) => (
                  <SwipeableContactListItem
                    key={contact._id}
                    contact={contact}
                    selected={selectedContactId === contact._id}
                    onClick={() => selectContact(contact._id)}
                    onArchive={() => requestRareAction("archive", contact._id)}
                    openSwipeId={openSwipeItemId}
                    onSwipeActiveChange={setOpenSwipeItemId}
                  />
                ))}
              </AnimatePresence>
              {hasMore && !debouncedSearch && (
                <div ref={loadMoreRef} className="p-4 flex justify-center">
                  {isLoadingMore && (
                    <Loader2 size={20} strokeWidth={1.5} className="text-muted-foreground animate-spin" />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Panel>

      {/* Detail Panel */}
      <Panel position="last">
        <ContactDetail
          contactId={selectedContactId}
        />
      </Panel>

      <AlertDialog
        open={pendingRareAction !== null}
        onOpenChange={(open) => {
          if (!open && !isApplyingRareAction) {
            setPendingRareAction(null)
          }
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Archive contact?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {`Archive ${pendingRareAction?.contactName}? This hides them from active contacts and stops 1:1 action suggestions for this person. Group chats may still create actions.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isApplyingRareAction}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void handleConfirmRareAction()
              }}
              disabled={isApplyingRareAction}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
