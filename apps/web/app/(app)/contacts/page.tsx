"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useQuery, useMutation } from "convex/react"
import {
  Mail,
  MessageSquare,
  Phone,
  Users,
  Search,
  Loader2,
  ScanSearch,
  Send,
  Trash2,
  ChevronRight,
} from "lucide-react"
import { api } from "@prm/convex"
import {
  getInitials,
  normalizePhone,
  type ActionPlatform,
  PLATFORM_CONFIG,
} from "@prm/shared"
import {
  SendMessageModal,
  type SendMessageContact,
} from "@prm/ui"
import {
  Card,
  CardContent,
  Skeleton,
  Badge,
  Avatar,
  AvatarFallback,
  Input,
  Button,
} from "@prm/ui"
import type { Id } from "@prm/convex"

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


function deduplicateHandles(handles: Array<{ type: string; value: string; platform: string }>) {
  const seen = new Map<string, { type: string; value: string; platform: string }>()

  for (const handle of handles) {
    let key: string

    if (handle.type === "phone") {
      key = `phone:${normalizePhone(handle.value)}`
      if (seen.has(key)) {
        const existing = seen.get(key)!
        if (handle.value.startsWith("+") && !existing.value.startsWith("+")) {
          seen.set(key, { ...handle })
        }
        continue
      }
    } else {
      key = `${handle.type}:${handle.value.toLowerCase()}`
    }

    seen.set(key, { ...handle })
  }

  return Array.from(seen.values())
}

const VALID_PLATFORMS: Set<ActionPlatform> = new Set([
  "imessage",
  "gmail",
  "slack",
  "linkedin",
  "twitter",
  "signal",
  "whatsapp",
])

function toActionPlatform(platform: string): ActionPlatform | null {
  const normalized = platform.toLowerCase() as ActionPlatform
  return VALID_PLATFORMS.has(normalized) ? normalized : null
}

/** Maps platform to expected handle type for sendable platforms */
const SENDABLE_HANDLE_TYPES: Record<string, string> = {
  imessage: "phone",
  gmail: "email",
  linkedin: "linkedin_handle",
  slack: "slack_id",
}

function getSendablePlatforms(
  handles: Array<{ type: string; value: string; platform: string }>
): Array<{ platform: ActionPlatform; handle: string }> {
  const result: Array<{ platform: ActionPlatform; handle: string }> = []
  const seen = new Set<ActionPlatform>()

  for (const handle of handles) {
    const actionPlatform = toActionPlatform(handle.platform)
    if (!actionPlatform || seen.has(actionPlatform)) continue

    const expectedType = SENDABLE_HANDLE_TYPES[actionPlatform]
    if (expectedType && handle.type === expectedType) {
      result.push({ platform: actionPlatform, handle: handle.value })
      seen.add(actionPlatform)
    }
  }

  return result
}

/** Prioritize handles for display: phones first, then emails, then others */
function prioritizeHandles(
  handles: Array<{ type: string; value: string; platform: string }>
): Array<{ type: string; value: string; platform: string }> {
  const phones = handles.filter((h) => h.type === "phone")
  const emails = handles.filter((h) => h.type === "email")
  const others = handles.filter((h) => h.type !== "phone" && h.type !== "email")

  // Interleave phones and emails, then append others
  const result: Array<{ type: string; value: string; platform: string }> = []
  const maxPriority = Math.max(phones.length, emails.length)
  for (let i = 0; i < maxPriority; i++) {
    if (phones[i]) result.push(phones[i])
    if (emails[i]) result.push(emails[i])
  }
  return [...result, ...others]
}

interface ContactRowProps {
  contact: {
    _id: Id<"contacts">
    displayName: string
    company?: string | null
    handles: Array<{ type: string; value: string; platform: string }>
  }
  onSendMessage: (contact: SendMessageContact) => void
  onClick: () => void
}

function ContactRow({ contact, onSendMessage, onClick }: ContactRowProps) {
  const uniqueHandles = deduplicateHandles(contact.handles)
  const prioritizedHandles = prioritizeHandles(uniqueHandles)
  const displayedHandles = prioritizedHandles.slice(0, 3)
  const hiddenCount = uniqueHandles.length - displayedHandles.length

  const sendablePlatforms = getSendablePlatforms(contact.handles)
  const platforms = [...new Set(contact.handles.map((h) => h.platform))]

  function handleSendClick(e: React.MouseEvent): void {
    e.stopPropagation()
    if (sendablePlatforms.length > 0) {
      onSendMessage({
        id: contact._id,
        name: contact.displayName,
        platforms: sendablePlatforms,
      })
    }
  }

  return (
    <div
      className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer group transition-colors"
      onClick={onClick}
    >
      <Avatar size="sm">
        <AvatarFallback>{getInitials(contact.displayName)}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{contact.displayName}</span>
          {contact.company && (
            <span className="text-xs text-muted-foreground">• {contact.company}</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1">
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
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {displayedHandles.map((handle, i) => (
                <span key={i} className="flex items-center gap-1">
                  <HandleIcon type={handle.type} />
                  <span className="truncate max-w-[120px]">{handle.value}</span>
                </span>
              ))}
              {hiddenCount > 0 && (
                <span className="text-muted-foreground/60">+{hiddenCount}</span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {sendablePlatforms.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSendClick}
            className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          >
            <Send className="w-4 h-4" />
          </Button>
        )}
        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </div>
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

export default function ContactsPage() {
  const router = useRouter()

  // Search state
  const [searchInput, setSearchInput] = React.useState("")
  const debouncedSearch = useDebounce(searchInput, 300)

  // Send message modal state
  const [sendModalOpen, setSendModalOpen] = React.useState(false)
  const [selectedContact, setSelectedContact] = React.useState<SendMessageContact | null>(null)

  // Pagination state
  const [cursor, setCursor] = React.useState<ContactCursor | undefined>(undefined)
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
    contactsResult?.nextCursor !== null && contactsResult?.nextCursor !== undefined

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

  const triggerMergeScan = useMutation(api.contactResolution.triggerMergeScan)
  const clearMergeSuggestions = useMutation(
    api.contactResolution.clearPendingMergeSuggestions
  )
  const queueMessage = useMutation(api.messageQueue.queueMessage)

  const [isScanning, setIsScanning] = React.useState(false)
  const [isClearing, setIsClearing] = React.useState(false)

  const handleTriggerScan = React.useCallback(async () => {
    setIsScanning(true)
    try {
      await triggerMergeScan({})
    } catch (error) {
      console.error("Failed to trigger merge scan:", error)
    } finally {
      setTimeout(() => setIsScanning(false), 2000)
    }
  }, [triggerMergeScan])

  const handleClearSuggestions = React.useCallback(async () => {
    setIsClearing(true)
    try {
      let hasMore = true
      while (hasMore) {
        const result = await clearMergeSuggestions({})
        hasMore = result.hasMore
      }
    } catch (error) {
      console.error("Failed to clear suggestions:", error)
    } finally {
      setIsClearing(false)
    }
  }, [clearMergeSuggestions])

  const handleOpenSendModal = React.useCallback((contact: SendMessageContact) => {
    setSelectedContact(contact)
    setSendModalOpen(true)
  }, [])

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
        recipientContactId: params.recipientContactId as Id<"contacts"> | undefined,
        text: params.text,
        isGroup: false,
        conversationId: params.conversationId as Id<"conversations"> | undefined,
      })
      return result
    },
    [queueMessage]
  )

  const handleContactClick = React.useCallback(
    (contactId: Id<"contacts">) => {
      router.push(`/contacts/${contactId}`)
    },
    [router]
  )

  if (contactsLoading && allContacts.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b">
          <div className="mx-auto max-w-2xl px-6 py-4">
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-8 p-6">
            <div className="space-y-4">
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-full rounded-xl" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  const displayContacts =
    allContacts.length > 0 ? allContacts : (contactsResult?.contacts ?? [])

  return (
    <div className="flex h-full flex-col">
      {/* Sticky Search Bar */}
      <div className="sticky top-0 z-10 bg-background border-b">
        <div className="mx-auto max-w-2xl px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
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
            <Button
              variant="outline"
              size="icon"
              onClick={handleTriggerScan}
              disabled={isScanning}
              title="Scan for duplicate contacts"
            >
              {isScanning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ScanSearch className="w-4 h-4" />
              )}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={handleClearSuggestions}
              disabled={isClearing}
              title="Clear pending merge suggestions"
            >
              {isClearing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-8 p-6">
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Users className="w-5 h-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">People</h2>
              <Badge variant="secondary" className="ml-2">
                {totalCount}
              </Badge>
            </div>

            {displayContacts.length === 0 && !contactsLoading ? (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  {debouncedSearch ? (
                    <p>No people matching &quot;{debouncedSearch}&quot;</p>
                  ) : (
                    <p>No contacts yet. Connect Gmail or iMessage to import contacts.</p>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0 divide-y divide-border">
                  {displayContacts.map((contact) => (
                    <ContactRow
                      key={contact._id}
                      contact={contact}
                      onSendMessage={handleOpenSendModal}
                      onClick={() => handleContactClick(contact._id)}
                    />
                  ))}
                </CardContent>
                {hasMore && !debouncedSearch && (
                  <div ref={loadMoreRef} className="p-4 flex justify-center">
                    {isLoadingMore && (
                      <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
                    )}
                  </div>
                )}
              </Card>
            )}
          </section>
        </div>
      </div>

      {/* Send Message Modal */}
      <SendMessageModal
        open={sendModalOpen}
        onOpenChange={setSendModalOpen}
        contact={selectedContact ?? undefined}
        onSend={handleSendMessage}
      />
    </div>
  )
}
