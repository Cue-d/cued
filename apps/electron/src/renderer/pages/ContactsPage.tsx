import * as React from "react"
import { useQuery } from "convex/react"
import {
  Users,
  Search,
  Loader2,
} from "lucide-react"
import { motion, AnimatePresence } from "motion/react"
import { api } from "@cued/convex"
import {
  getInitials,
  type ActionPlatform,
  PLATFORM_CONFIG,
} from "@cued/shared"
import {
  EmptyState,
  PlatformIcon,
} from "@cued/ui"
import { ActionFilterDropdown, type ActionFilterDropdownRef } from "../components/action-filter-dropdown"
import {
  Skeleton,
  Badge,
  Avatar,
  AvatarFallback,
  Input,
} from "@cued/ui"
import type { Id } from "@cued/convex"
import { Panel, PanelHeader } from "../components/app-shell"
import { ContactDetail, HandleIcon, deduplicateHandles, prioritizeHandles, VISIBLE_HANDLE_TYPES } from "../components/contacts/ContactDetail"

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

interface ContactListItemProps {
  contact: {
    _id: Id<"contacts">
    displayName: string
    company?: string | null
    handles: Array<{ type: string; value: string; platform: string }>
  }
  selected: boolean
  onClick: () => void
}

function ContactListItem({ contact, selected, onClick }: ContactListItemProps) {
  const uniqueHandles = deduplicateHandles(contact.handles)
  const visibleHandles = uniqueHandles.filter((h) => VISIBLE_HANDLE_TYPES.has(h.type))
  const prioritizedHandles = prioritizeHandles(visibleHandles)
  const displayedHandles = prioritizedHandles.slice(0, 2)
  const platforms = [...new Set(contact.handles.map((h) => h.platform))]

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 cursor-pointer rounded-lg transition-colors ${
        selected ? "bg-foreground/[0.07]" : "hover:bg-foreground/5"
      }`}
    >
      <div className="flex items-center gap-3">
        <Avatar size="sm">
          <AvatarFallback>{getInitials(contact.displayName)}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">
              {contact.displayName}
            </span>
            {contact.company && (
              <span className="text-xs text-muted-foreground truncate">
                • {contact.company}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <div className="flex gap-1">
              {platforms.slice(0, 3).map((platform) => {
                const config = PLATFORM_CONFIG[platform as ActionPlatform]
                return (
                  <Badge
                    key={platform}
                    variant="secondary"
                    className={`text-[10px] px-1.5 py-0 ${config?.bgClass ?? ""}`}
                  >
                    <PlatformIcon platform={platform as ActionPlatform} className="w-2.5 h-2.5" />
                  </Badge>
                )
              })}
            </div>
            {displayedHandles.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {displayedHandles.map((handle, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <HandleIcon type={handle.type} />
                    <span className="truncate max-w-[80px]">{handle.value}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </button>
  )
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

interface ContactsPageProps {
  initialContactId?: string | null
  onInitialContactConsumed?: () => void
}

export function ContactsPage({ initialContactId, onInitialContactConsumed }: ContactsPageProps): React.JSX.Element {
  const [selectedContactId, setSelectedContactId] =
    React.useState<Id<"contacts"> | null>(null)

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

  const [cursor, setCursor] = React.useState<ContactCursor | undefined>(
    undefined
  )
  const [allContacts, setAllContacts] = React.useState<
    Array<{
      _id: Id<"contacts">
      displayName: string
      company?: string | null
      handles: Array<{ type: string; value: string; platform: string }>
    }>
  >([])
  const [isLoadingMore, setIsLoadingMore] = React.useState(false)
  const autoLoadAttemptsRef = React.useRef(0)

  const loadMoreRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    setCursor(undefined)
    setAllContacts([])
  }, [debouncedSearch])

  const contactsResult = useQuery(api.contacts.getContacts, {
    limit: 50,
    cursor,
    searchQuery: debouncedSearch || undefined,
  })
  const contactsLoading = contactsResult === undefined
  const hasMore =
    contactsResult?.nextCursor !== null &&
    contactsResult?.nextCursor !== undefined

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
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (
          entry.isIntersecting &&
          contactsResult?.nextCursor &&
          !isLoadingMore &&
          !debouncedSearch
        ) {
          setIsLoadingMore(true)
          setCursor(contactsResult.nextCursor)
        }
      },
      { rootMargin: "100px" }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [contactsResult?.nextCursor, isLoadingMore, debouncedSearch])

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

  // Auto-load more pages when client-side filters leave too few visible contacts
  // (e.g. phone-number contacts sort first alphabetically and get filtered out)
  // Cap at 5 consecutive auto-loads to prevent runaway queries.
  React.useEffect(() => {
    if (
      displayContacts.length < 10 &&
      contactsResult?.nextCursor &&
      !isLoadingMore &&
      !debouncedSearch &&
      autoLoadAttemptsRef.current < 5
    ) {
      autoLoadAttemptsRef.current++
      setIsLoadingMore(true)
      setCursor(contactsResult.nextCursor)
    }
  }, [displayContacts.length, contactsResult?.nextCursor, isLoadingMore, debouncedSearch])

  // Reset auto-load counter when filters change
  React.useEffect(() => {
    autoLoadAttemptsRef.current = 0
  }, [activePlatforms, namedOnly, debouncedSearch])

  const filteredCount = displayContacts.length

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
      if (e.key === "ArrowUp" && displayContacts.length > 0) {
        e.preventDefault()
        const currentIndex = displayContacts.findIndex(
          (c) => c._id === selectedContactId
        )
        if (currentIndex > 0) {
          setSelectedContactId(displayContacts[currentIndex - 1]._id)
        }
      } else if (e.key === "ArrowDown" && displayContacts.length > 0) {
        e.preventDefault()
        const currentIndex = displayContacts.findIndex(
          (c) => c._id === selectedContactId
        )
        if (currentIndex < displayContacts.length - 1) {
          setSelectedContactId(displayContacts[currentIndex + 1]._id)
        } else if (currentIndex === -1) {
          setSelectedContactId(displayContacts[0]._id)
        }
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault()
        filterRef.current?.open()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [displayContacts, selectedContactId])

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
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search people..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9 pr-4"
            />
            {contactsLoading && debouncedSearch && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
            )}
          </div>
        </div>

        {/* Contact List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {displayContacts.length === 0 ? (
            <EmptyState
              icon={<Users className="w-6 h-6 text-muted-foreground" />}
              title={debouncedSearch ? `No results for "${debouncedSearch}"` : activePlatforms.size > 0 ? "No contacts on this platform" : "No contacts yet"}
              description={!debouncedSearch && activePlatforms.size === 0 ? "Connect Gmail or iMessage to import contacts." : undefined}
              className="py-12"
            />
          ) : (
            <>
              <AnimatePresence mode="popLayout">
                {displayContacts.map((contact) => (
                  <motion.div
                    key={contact._id}
                    layout
                    initial={{ opacity: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.12, ease: "easeOut" }}
                  >
                    <ContactListItem
                      contact={contact}
                      selected={selectedContactId === contact._id}
                      onClick={() => setSelectedContactId(contact._id)}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
              {hasMore && !debouncedSearch && (
                <div ref={loadMoreRef} className="p-4 flex justify-center">
                  {isLoadingMore && (
                    <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
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
    </>
  )
}
