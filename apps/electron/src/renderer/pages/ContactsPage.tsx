import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import {
  Mail,
  MessageSquare,
  Phone,
  Users,
  Search,
  Loader2,
} from "lucide-react"
import { api } from "@cued/convex"
import {
  getInitials,
  type ActionPlatform,
  PLATFORM_CONFIG,
} from "@cued/shared"
import {
  SendMessageModal,
  EmptyState,
  type SendMessageContact,
} from "@cued/ui"
import {
  Skeleton,
  Badge,
  Avatar,
  AvatarFallback,
  Input,
} from "@cued/ui"
import type { Id } from "@cued/convex"
import { Panel, PanelHeader } from "../components/app-shell"
import { ContactDetail, deduplicateHandles, prioritizeHandles } from "../components/contacts/ContactDetail"

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
  const prioritizedHandles = prioritizeHandles(uniqueHandles)
  const displayedHandles = prioritizedHandles.slice(0, 2)
  const platforms = [...new Set(contact.handles.map((h) => h.platform))]

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
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
                    className={`text-[10px] px-1.5 py-0 ${config?.bgClass ?? ""} ${config?.textClass ?? ""}`}
                  >
                    {config?.letter ?? platform.charAt(0).toUpperCase()}
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
  onContactCountChange?: (count: number) => void
}

export function ContactsPage({ onContactCountChange }: ContactsPageProps): React.JSX.Element {
  const [selectedContactId, setSelectedContactId] =
    React.useState<Id<"contacts"> | null>(null)
  const [searchInput, setSearchInput] = React.useState("")
  const debouncedSearch = useDebounce(searchInput, 300)

  const [sendModalOpen, setSendModalOpen] = React.useState(false)
  const [selectedSendContact, setSelectedSendContact] =
    React.useState<SendMessageContact | null>(null)

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
  const totalCount = allContacts.length
  const hasMore =
    contactsResult?.nextCursor !== null &&
    contactsResult?.nextCursor !== undefined

  // Report contact count to parent
  React.useEffect(() => {
    onContactCountChange?.(totalCount)
  }, [totalCount, onContactCountChange])

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

  const queueMessage = useMutation(api.messageQueue.queueMessage)

  const handleOpenSendModal = React.useCallback(
    (contact: SendMessageContact) => {
      setSelectedSendContact(contact)
      setSendModalOpen(true)
    },
    []
  )

  const handleSendMessage = React.useCallback(
    async (params: {
      platform: ActionPlatform
      recipientHandle: string
      recipientContactId?: string
      text: string
      conversationId?: string
    }) => {
      const result = await queueMessage({
        platform: params.platform,
        recipientHandle: params.recipientHandle,
        recipientContactId: params.recipientContactId as
          | Id<"contacts">
          | undefined,
        text: params.text,
        isGroup: false,
        conversationId: params.conversationId as
          | Id<"conversations">
          | undefined,
      })
      return result
    },
    [queueMessage]
  )

  const displayContacts =
    allContacts.length > 0 ? allContacts : contactsResult?.contacts ?? []

  // Loading skeleton (only on initial load, not when searching)
  if (contactsLoading && allContacts.length === 0 && !searchInput) {
    return (
      <>
        <Panel variant="shrink" width={320} position="first">
          <PanelHeader title="Contacts" />
          <div className="flex gap-1.5 px-3 pb-2">
            <Skeleton className="h-6 w-14 rounded-full" />
          </div>
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
        <PanelHeader title="Contacts" />

        {/* Count Chip */}
        <div className="flex gap-1.5 px-3 pb-2">
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-foreground text-background">
            All {totalCount > 0 && <span className="ml-1 opacity-70">{totalCount}</span>}
          </span>
        </div>

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
              title={debouncedSearch ? `No results for "${debouncedSearch}"` : "No contacts yet"}
              description={!debouncedSearch ? "Connect Gmail or iMessage to import contacts." : undefined}
              className="py-12"
            />
          ) : (
            <>
              {displayContacts.map((contact) => (
                <ContactListItem
                  key={contact._id}
                  contact={contact}
                  selected={selectedContactId === contact._id}
                  onClick={() => setSelectedContactId(contact._id)}
                />
              ))}
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
          onSendMessage={handleOpenSendModal}
        />
      </Panel>

      {/* Send Message Modal */}
      <SendMessageModal
        open={sendModalOpen}
        onOpenChange={setSendModalOpen}
        contact={selectedSendContact ?? undefined}
        onSend={handleSendMessage}
      />
    </>
  )
}
