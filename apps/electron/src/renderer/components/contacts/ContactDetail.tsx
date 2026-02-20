import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import {
  Mail,
  Phone,
  Loader2,
  ChevronDown,
  ChevronUp,
  Pencil,
  Save,
  X,
} from 'lucide-react'
import { api } from "@cued/convex"
import {
  normalizePhone,
  getInitials,
  formatRelativeTime,
  type ActionPlatform,
  PLATFORM_CONFIG,
} from "@cued/shared"
import {
  EmptyState,
  PlatformIcon,
  ScrollArea,
  SearchIcon,
  UserIcon,
  Avatar,
  AvatarImage,
  AvatarFallback,
} from "@cued/ui"
import {
  Skeleton,
  Badge,
  Input,
  Button,
  Textarea,
} from "@cued/ui"
import type { Id } from "@cued/convex"
import { PanelHeader } from "../app-shell"
import { SettingsSection, SettingsCard, SettingsRow } from "../settings-card"

/** Handle types worth displaying to the user (hide internal IDs like slack_id, linkedin_urn) */
export const VISIBLE_HANDLE_TYPES = new Set(["phone", "email", "linkedin_handle", "twitter_handle"])

export function HandleIcon({ type }: { type: string }) {
  switch (type) {
    case "phone":
      return <Phone size={12} strokeWidth={1.5} className="text-muted-foreground" />
    case "email":
      return <Mail size={12} strokeWidth={1.5} className="text-muted-foreground" />
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

const HANDLE_TYPE_LABELS: Record<string, string> = {
  phone: "Phone",
  email: "Email",
  linkedin_handle: "LinkedIn",
  twitter_handle: "Twitter",
}

function PlatformBadge({ platform }: { platform: ActionPlatform }) {
  const config = PLATFORM_CONFIG[platform]
  return (
    <Badge
      variant="secondary"
      className="text-xs gap-1"
      style={config ? { backgroundColor: config.color, color: 'white' } : undefined}
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
}

export function ContactDetail({ contactId }: ContactDetailProps) {
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
      <div className="h-full flex flex-col">
        <PanelHeader title="Contact" />
        <div className="px-5 py-7 max-w-3xl mx-auto space-y-6 w-full">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
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
  const visibleHandles = contact.handles.filter((h) => VISIBLE_HANDLE_TYPES.has(h.type))
  const initials = getInitials(contact.displayName)

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={contact.displayName} subtitle={contact.company || undefined}>
        <div className="flex items-center gap-1.5">
          {isEditing ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsEditing(false)}
              >
                <X size={14} strokeWidth={1.5} />
              </Button>
              <Button size="sm" onClick={handleSave} disabled={isSaving}>
                {isSaving ? (
                  <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
                ) : (
                  <>
                    <Save size={14} strokeWidth={1.5} className="mr-1.5" />
                    Save
                  </>
                )}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsEditing(true)}
            >
              <Pencil size={14} strokeWidth={1.5} />
            </Button>
          )}
        </div>
      </PanelHeader>

      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto space-y-8">
            <SettingsSection title="Profile">
              <SettingsCard divided={false}>
                <div className="px-4 py-4 flex items-center gap-4">
                  <Avatar size="lg">
                    {contact.avatarUrl ? (
                      <AvatarImage src={contact.avatarUrl} alt={contact.displayName} />
                    ) : null}
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-base font-semibold truncate">{contact.displayName}</p>
                    <p className="text-sm text-muted-foreground truncate">
                      {contact.company || "No company set"}
                    </p>
                  </div>
                </div>
              </SettingsCard>
            </SettingsSection>

            {/* Overview */}
            <SettingsSection title="Overview">
              <SettingsCard>
                <SettingsRow label="Messages" description={`${stats.totalMessages} total`} />
                <SettingsRow label="Recent" description={`${stats.recentMessageCount} in last 30 days`} />
                <SettingsRow
                  label="Last contacted"
                  description={stats.lastContactedAt ? formatRelativeTime(stats.lastContactedAt) : "Never"}
                />
                <SettingsRow label="Platforms">
                  <div className="flex gap-1.5">
                    {[...new Set(contact.handles.map((h) => h.platform))].map((p) => (
                      <PlatformBadge key={p} platform={p as ActionPlatform} />
                    ))}
                  </div>
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>

            {/* Details */}
            <SettingsSection title="Details">
              <SettingsCard>
                {isEditing ? (
                  <SettingsRow label="Name">
                    <Input
                      value={editForm.displayName}
                      onChange={(e) =>
                        setEditForm((f) => ({ ...f, displayName: e.target.value }))
                      }
                      className="w-48"
                    />
                  </SettingsRow>
                ) : null}
                <SettingsRow label="Company">
                  {isEditing ? (
                    <Input
                      value={editForm.company}
                      onChange={(e) =>
                        setEditForm((f) => ({ ...f, company: e.target.value }))
                      }
                      placeholder="Company name"
                      className="w-48"
                    />
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {contact.company || "\u2014"}
                    </span>
                  )}
                </SettingsRow>
                <SettingsRow label="Tags">
                  {isEditing ? (
                    <Input
                      value={editForm.tags}
                      onChange={(e) =>
                        setEditForm((f) => ({ ...f, tags: e.target.value }))
                      }
                      placeholder="Comma-separated"
                      className="w-48"
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
                    <span className="text-sm text-muted-foreground">{"\u2014"}</span>
                  )}
                </SettingsRow>
                {visibleHandles.map((handle, i) => (
                  <SettingsRow
                    key={i}
                    label={HANDLE_TYPE_LABELS[handle.type] ?? handle.type}
                    description={handle.value}
                  >
                    <PlatformBadge platform={handle.platform as ActionPlatform} />
                  </SettingsRow>
                ))}
              </SettingsCard>
            </SettingsSection>

            {/* Notes */}
            <SettingsSection title="Notes">
              <SettingsCard divided={false}>
                <div className="px-4 py-3.5">
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
                </div>
              </SettingsCard>
            </SettingsSection>

            {/* Recent Conversations */}
            {conversations.length > 0 && (
              <SettingsSection title="Conversations">
                <SettingsCard>
                  {conversations.map((conv) => (
                    <SettingsRow
                      key={conv._id}
                      label={conv.displayName || "Direct Message"}
                      description={conv.lastMessageText || undefined}
                    >
                      <div className="flex items-center gap-2">
                        <PlatformBadge platform={conv.platform} />
                        {conv.lastMessageAt && (
                          <span className="text-xs text-muted-foreground">
                            {formatRelativeTime(conv.lastMessageAt)}
                          </span>
                        )}
                      </div>
                    </SettingsRow>
                  ))}
                </SettingsCard>
              </SettingsSection>
            )}

            {/* Message Timeline */}
            <SettingsSection title="Messages">
              <SettingsCard divided={false}>
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-4 py-3.5 cursor-pointer"
                  onClick={() => setTimelineExpanded(!timelineExpanded)}
                >
                  <span className="text-sm font-medium">
                    Timeline
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{messages.length}</Badge>
                    {timelineExpanded ? (
                      <ChevronUp size={16} strokeWidth={1.5} className="text-muted-foreground" />
                    ) : (
                      <ChevronDown size={16} strokeWidth={1.5} className="text-muted-foreground" />
                    )}
                  </div>
                </button>
                {timelineExpanded && (
                  <>
                    <div className="h-px bg-border/50 mx-4" />
                    <div className="px-4 py-3.5">
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
                    </div>
                  </>
                )}
              </SettingsCard>
            </SettingsSection>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
