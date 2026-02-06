import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import {
  Mail,
  MessageSquare,
  Phone,
  Loader2,
  Send,
  Building2,
  Calendar,
  Clock,
  ChevronDown,
  ChevronUp,
  Edit2,
  Save,
  Tag,
  User,
  X,
} from "lucide-react"
import { api } from "@cued/convex"
import {
  getInitials,
  normalizePhone,
  formatRelativeTime,
  type ActionPlatform,
  PLATFORM_CONFIG,
} from "@cued/shared"
import {
  EmptyState,
  PlatformIcon,
  SearchIcon,
  UserIcon,
  type SendMessageContact,
} from "@cued/ui"
import {
  Card,
  CardContent,
  CardHeader,
  Skeleton,
  Badge,
  Avatar,
  AvatarFallback,
  Input,
  Button,
  Textarea,
} from "@cued/ui"
import type { Id } from "@cued/convex"

/** Handle types worth displaying to the user (hide internal IDs like slack_id, linkedin_urn) */
export const VISIBLE_HANDLE_TYPES = new Set(["phone", "email", "linkedin_handle", "twitter_handle"])

export function HandleIcon({ type }: { type: string }) {
  switch (type) {
    case "phone":
      return <Phone className="w-3 h-3 text-muted-foreground" />
    case "email":
      return <Mail className="w-3 h-3 text-muted-foreground" />
    case "linkedin_handle":
      return <PlatformIcon platform="linkedin" className="w-3 h-3 text-muted-foreground" />
    case "twitter_handle":
      return <PlatformIcon platform="twitter" className="w-3 h-3 text-muted-foreground" />
    default:
      return null
  }
}

export function deduplicateHandles(
  handles: Array<{ type: string; value: string; platform: string }>
) {
  const seen = new Map<
    string,
    { type: string; value: string; platform: string }
  >()

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

export const SENDABLE_HANDLE_TYPES: Record<string, string> = {
  imessage: "phone",
  gmail: "email",
  linkedin: "linkedin_handle",
  slack: "slack_id",
}

export function prioritizeHandles(
  handles: Array<{ type: string; value: string; platform: string }>
): Array<{ type: string; value: string; platform: string }> {
  const phones = handles.filter((h) => h.type === "phone")
  const emails = handles.filter((h) => h.type === "email")
  const others = handles.filter(
    (h) => h.type !== "phone" && h.type !== "email"
  )

  const result: Array<{ type: string; value: string; platform: string }> = []
  const maxPriority = Math.max(phones.length, emails.length)
  for (let i = 0; i < maxPriority; i++) {
    if (phones[i]) result.push(phones[i])
    if (emails[i]) result.push(emails[i])
  }
  return [...result, ...others]
}

function PlatformBadge({ platform }: { platform: ActionPlatform }) {
  const config = PLATFORM_CONFIG[platform]
  return (
    <Badge
      variant="secondary"
      className={`text-xs gap-1 ${config?.bgClass ?? ""}`}
    >
      <PlatformIcon platform={platform} className="w-3 h-3" />
      {config?.label ?? platform}
    </Badge>
  )
}

function TimelineMessage({
  message,
}: {
  message: {
    _id: string
    content: string
    sentAt: number
    isFromMe: boolean
    platform: ActionPlatform
  }
}) {
  return (
    <div
      className={`flex gap-3 ${message.isFromMe ? "flex-row-reverse" : ""}`}
    >
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          message.isFromMe
            ? "bg-primary text-primary-foreground"
            : "bg-muted"
        }`}
      >
        <p className="whitespace-pre-wrap wrap-break-word">{message.content}</p>
        <div
          className={`flex items-center gap-2 mt-1 text-xs opacity-70 ${message.isFromMe ? "justify-end" : ""}`}
        >
          <PlatformBadge platform={message.platform} />
          <span>{formatRelativeTime(message.sentAt)}</span>
        </div>
      </div>
    </div>
  )
}

interface ContactDetailProps {
  contactId: Id<"contacts"> | null
  onSendMessage: (contact: SendMessageContact) => void
}

export function ContactDetail({ contactId, onSendMessage }: ContactDetailProps) {
  const profile = useQuery(
    api.contacts.getContactProfile,
    contactId ? { contactId } : "skip"
  )
  const updateContact = useMutation(api.contacts.updateContact)

  const [isEditing, setIsEditing] = React.useState(false)
  const [editForm, setEditForm] = React.useState({
    displayName: "",
    company: "",
    notes: "",
    tags: "",
  })
  const [isSaving, setIsSaving] = React.useState(false)

  const [timelineExpanded, setTimelineExpanded] = React.useState(true)
  const [showAllMessages, setShowAllMessages] = React.useState(false)

  React.useEffect(() => {
    if (profile?.contact) {
      setEditForm({
        displayName: profile.contact.displayName,
        company: profile.contact.company ?? "",
        notes: profile.contact.notes ?? "",
        tags: profile.contact.tags?.join(", ") ?? "",
      })
    }
  }, [profile?.contact])

  const handleSave = async () => {
    if (!contactId) return
    setIsSaving(true)
    try {
      await updateContact({
        contactId,
        displayName: editForm.displayName,
        company: editForm.company || undefined,
        notes: editForm.notes || undefined,
        tags: editForm.tags
          ? editForm.tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined,
      })
      setIsEditing(false)
    } catch (e) {
      console.error("Failed to save:", e)
    } finally {
      setIsSaving(false)
    }
  }

  const sendContact = React.useMemo((): SendMessageContact | undefined => {
    if (!profile?.contact || !contactId) return undefined

    const platforms: Array<{ platform: ActionPlatform; handle: string }> = []
    for (const handle of profile.contact.handles) {
      const expectedType = SENDABLE_HANDLE_TYPES[handle.platform]
      if (expectedType && handle.type === expectedType) {
        platforms.push({
          platform: handle.platform as ActionPlatform,
          handle: handle.value,
        })
      }
    }

    if (platforms.length === 0) return undefined
    return {
      id: contactId,
      name: profile.contact.displayName,
      platforms,
    }
  }, [profile?.contact, contactId])

  if (!contactId) {
    return (
      <EmptyState
        animatedIcon={SearchIcon}
        title="Select a contact"
        description="Choose someone from the list to view their profile"
      />
    )
  }

  if (profile === undefined) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (profile === null) {
    return (
      <EmptyState
        animatedIcon={UserIcon}
        title="Contact not found"
        description="This contact may have been removed or merged"
      />
    )
  }

  const { contact, conversations, messages, stats } = profile
  const displayMessages = showAllMessages ? messages : messages.slice(0, 10)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 p-4">
        <div className="flex items-center gap-4">
          <Avatar size="lg">
            <AvatarFallback className="text-lg">
              {getInitials(contact.displayName)}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <Input
                value={editForm.displayName}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, displayName: e.target.value }))
                }
                className="text-xl font-semibold"
              />
            ) : (
              <h1 className="text-xl font-semibold truncate">
                {contact.displayName}
              </h1>
            )}
            {contact.company && !isEditing && (
              <p className="text-sm text-muted-foreground">{contact.company}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {sendContact && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSendMessage(sendContact)}
              >
                <Send className="w-4 h-4 mr-2" />
                Message
              </Button>
            )}
            {isEditing ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsEditing(false)}
                >
                  <X className="w-4 h-4" />
                </Button>
                <Button size="sm" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  Save
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsEditing(true)}
              >
                <Edit2 className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl space-y-6 p-6">
          {/* Quick Stats */}
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4 text-center">
                <MessageSquare className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                <div className="text-2xl font-semibold">
                  {stats.totalMessages}
                </div>
                <div className="text-xs text-muted-foreground">Messages</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <Calendar className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                <div className="text-2xl font-semibold">
                  {stats.recentMessageCount}
                </div>
                <div className="text-xs text-muted-foreground">Last 30 days</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <Clock className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                <div className="text-sm font-medium">
                  {stats.lastContactedAt
                    ? formatRelativeTime(stats.lastContactedAt)
                    : "Never"}
                </div>
                <div className="text-xs text-muted-foreground">Last contact</div>
              </CardContent>
            </Card>
          </div>

          {/* Contact Details */}
          <Card>
            <CardHeader className="pb-3">
              <h2 className="font-semibold flex items-center gap-2">
                <User className="w-4 h-4" />
                Details
              </h2>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Company */}
              <div className="flex items-start gap-3">
                <Building2 className="w-4 h-4 mt-1 text-muted-foreground" />
                <div className="flex-1">
                  <div className="text-xs text-muted-foreground mb-1">
                    Company
                  </div>
                  {isEditing ? (
                    <Input
                      value={editForm.company}
                      onChange={(e) =>
                        setEditForm((f) => ({ ...f, company: e.target.value }))
                      }
                      placeholder="Company name"
                    />
                  ) : (
                    <div>{contact.company || "—"}</div>
                  )}
                </div>
              </div>

              {/* Tags */}
              <div className="flex items-start gap-3">
                <Tag className="w-4 h-4 mt-1 text-muted-foreground" />
                <div className="flex-1">
                  <div className="text-xs text-muted-foreground mb-1">Tags</div>
                  {isEditing ? (
                    <Input
                      value={editForm.tags}
                      onChange={(e) =>
                        setEditForm((f) => ({ ...f, tags: e.target.value }))
                      }
                      placeholder="Comma-separated tags"
                    />
                  ) : contact.tags && contact.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {contact.tags.map((tag) => (
                        <Badge key={tag} variant="secondary">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <div className="text-muted-foreground">—</div>
                  )}
                </div>
              </div>

              {/* Handles */}
              <div>
                <div className="text-xs text-muted-foreground mb-2">
                  Contact Methods
                </div>
                <div className="space-y-2">
                  {contact.handles
                    .filter((h) => VISIBLE_HANDLE_TYPES.has(h.type))
                    .map((handle, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm">
                      <HandleIcon type={handle.type} />
                      <span className="flex-1 font-mono text-sm">
                        {handle.value}
                      </span>
                      <PlatformBadge platform={handle.platform as ActionPlatform} />
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader className="pb-3">
              <h2 className="font-semibold flex items-center gap-2">
                <Edit2 className="w-4 h-4" />
                Notes
              </h2>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <Textarea
                  value={editForm.notes}
                  onChange={(e) =>
                    setEditForm((f) => ({ ...f, notes: e.target.value }))
                  }
                  placeholder="Add notes about this contact..."
                  rows={4}
                />
              ) : contact.notes ? (
                <p className="text-sm whitespace-pre-wrap">{contact.notes}</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No notes yet. Click edit to add some.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Recent Conversations */}
          {conversations.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <h2 className="font-semibold flex items-center gap-2">
                  <MessageSquare className="w-4 h-4" />
                  Recent Conversations
                </h2>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {conversations.map((conv) => (
                    <div
                      key={conv._id}
                      className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50"
                    >
                      <PlatformBadge platform={conv.platform} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {conv.displayName || "Direct Message"}
                        </div>
                        {conv.lastMessageText && (
                          <div className="text-xs text-muted-foreground truncate">
                            {conv.lastMessageText}
                          </div>
                        )}
                      </div>
                      {conv.lastMessageAt && (
                        <div className="text-xs text-muted-foreground">
                          {formatRelativeTime(conv.lastMessageAt)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Message Timeline */}
          <Card>
            <CardHeader
              className="pb-3 cursor-pointer"
              onClick={() => setTimelineExpanded(!timelineExpanded)}
            >
              <div className="flex items-center justify-between">
                <h2 className="font-semibold flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  Message Timeline
                  <Badge variant="secondary" className="ml-2">
                    {messages.length}
                  </Badge>
                </h2>
                {timelineExpanded ? (
                  <ChevronUp className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
            </CardHeader>
            {timelineExpanded && (
              <CardContent>
                {messages.length > 0 ? (
                  <div className="space-y-3">
                    {displayMessages.map((msg) => (
                      <TimelineMessage key={msg._id} message={msg} />
                    ))}
                    {messages.length > 10 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full"
                        onClick={() => setShowAllMessages(!showAllMessages)}
                      >
                        {showAllMessages
                          ? "Show less"
                          : `Show ${messages.length - 10} more messages`}
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No messages yet.
                  </p>
                )}
              </CardContent>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
