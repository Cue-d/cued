"use client"

import * as React from "react"
import { useParams, useRouter } from "next/navigation"
import { useQuery, useMutation } from "convex/react"
import {
  ArrowLeft,
  Building2,
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  Edit2,
  Lightbulb,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  Save,
  Send,
  Sparkles,
  Tag,
  User,
  X,
} from "lucide-react"
import { fetchContactMemories, type ContactMemoryItem } from "@prm/ai"
import { api } from "@prm/convex"
import {
  getInitials,
  formatRelativeTime,
  PLATFORM_CONFIG,
  type ActionPlatform,
} from "@prm/shared"
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Input,
  Skeleton,
  Textarea,
  SendMessageModal,
  type SendMessageContact,
} from "@prm/ui"
import type { Id } from "@prm/convex"

function HandleIcon({ type }: { type: string }) {
  switch (type) {
    case "phone":
      return <Phone className="w-4 h-4" />
    case "email":
      return <Mail className="w-4 h-4" />
    case "slack_id":
      return <MessageSquare className="w-4 h-4" />
    default:
      return <User className="w-4 h-4" />
  }
}

function PlatformBadge({ platform }: { platform: ActionPlatform }) {
  const config = PLATFORM_CONFIG[platform]
  return (
    <Badge variant="secondary" className={`text-xs ${config?.bgClass ?? ""} ${config?.textClass ?? ""}`}>
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
    <div className={`flex gap-3 ${message.isFromMe ? "flex-row-reverse" : ""}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          message.isFromMe
            ? "bg-primary text-primary-foreground"
            : "bg-muted"
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
        <div className={`flex items-center gap-2 mt-1 text-xs opacity-70 ${message.isFromMe ? "justify-end" : ""}`}>
          <PlatformBadge platform={message.platform} />
          <span>{formatRelativeTime(message.sentAt)}</span>
        </div>
      </div>
    </div>
  )
}

export default function ContactDetailPage() {
  const params = useParams()
  const router = useRouter()
  const contactId = params.contactId as Id<"contacts">

  // Fetch contact profile
  const profile = useQuery(api.contacts.getContactProfile, { contactId })
  const updateContact = useMutation(api.contacts.updateContact)
  const queueMessage = useMutation(api.messageQueue.queueMessage)

  // Edit mode state
  const [isEditing, setIsEditing] = React.useState(false)
  const [editForm, setEditForm] = React.useState({
    displayName: "",
    company: "",
    notes: "",
    tags: "",
  })
  const [isSaving, setIsSaving] = React.useState(false)

  // Memories state
  const [memories, setMemories] = React.useState<ContactMemoryItem[]>([])
  const [memoriesLoading, setMemoriesLoading] = React.useState(false)
  const [memoriesExpanded, setMemoriesExpanded] = React.useState(true)

  // Timeline expansion
  const [timelineExpanded, setTimelineExpanded] = React.useState(true)
  const [showAllMessages, setShowAllMessages] = React.useState(false)

  // Send message modal
  const [sendModalOpen, setSendModalOpen] = React.useState(false)

  // Initialize edit form when profile loads
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

  // Fetch memories when profile loads
  React.useEffect(() => {
    async function loadMemories() {
      if (!profile?.contact) return
      setMemoriesLoading(true)
      try {
        const result = await fetchContactMemories(
          profile.contact.displayName,
          profile.contact.userId,
          contactId,
          20
        )
        setMemories(result)
      } catch (e) {
        console.error("Failed to fetch memories:", e)
      } finally {
        setMemoriesLoading(false)
      }
    }
    loadMemories()
  }, [profile?.contact, contactId])

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await updateContact({
        contactId,
        displayName: editForm.displayName,
        company: editForm.company || undefined,
        notes: editForm.notes || undefined,
        tags: editForm.tags
          ? editForm.tags.split(",").map((t) => t.trim()).filter(Boolean)
          : undefined,
      })
      setIsEditing(false)
    } catch (e) {
      console.error("Failed to save:", e)
    } finally {
      setIsSaving(false)
    }
  }

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

  // Build SendMessageContact from handles
  const sendContact = React.useMemo((): SendMessageContact | undefined => {
    if (!profile?.contact) return undefined

    const SENDABLE_HANDLE_TYPES: Record<string, string> = {
      imessage: "phone",
      gmail: "email",
      slack: "slack_id",
      linkedin: "linkedin_handle",
    }

    const platforms: Array<{ platform: ActionPlatform; handle: string }> = []
    for (const handle of profile.contact.handles) {
      const expectedType = SENDABLE_HANDLE_TYPES[handle.platform]
      if (expectedType && handle.type === expectedType) {
        platforms.push({ platform: handle.platform as ActionPlatform, handle: handle.value })
      }
    }

    if (platforms.length === 0) return undefined
    return {
      id: contactId,
      name: profile.contact.displayName,
      platforms,
    }
  }, [profile?.contact, contactId])

  if (profile === undefined) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b p-4">
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="flex-1 p-6 space-y-6">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  if (profile === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <User className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Contact not found</h2>
          <Button variant="outline" onClick={() => router.push("/contacts")} className="mt-4">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Contacts
          </Button>
        </div>
      </div>
    )
  }

  const { contact, conversations, messages, memoryStats, stats } = profile
  const displayMessages = showAllMessages ? messages : messages.slice(0, 10)

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b">
        <div className="mx-auto max-w-3xl px-6 py-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" onClick={() => router.push("/contacts")}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <Avatar size="lg">
              <AvatarFallback className="text-lg">
                {getInitials(contact.displayName)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              {isEditing ? (
                <Input
                  value={editForm.displayName}
                  onChange={(e) => setEditForm((f) => ({ ...f, displayName: e.target.value }))}
                  className="text-xl font-semibold"
                />
              ) : (
                <h1 className="text-xl font-semibold truncate">{contact.displayName}</h1>
              )}
              {contact.company && !isEditing && (
                <p className="text-sm text-muted-foreground">{contact.company}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {sendContact && (
                <Button variant="outline" size="sm" onClick={() => setSendModalOpen(true)}>
                  <Send className="w-4 h-4 mr-2" />
                  Message
                </Button>
              )}
              {isEditing ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)}>
                    <X className="w-4 h-4" />
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={isSaving}>
                    {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                    Save
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)}>
                  <Edit2 className="w-4 h-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          {/* Quick Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="p-4 text-center">
                <MessageSquare className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                <div className="text-2xl font-semibold">{stats.totalMessages}</div>
                <div className="text-xs text-muted-foreground">Messages</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <Calendar className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                <div className="text-2xl font-semibold">{stats.recentMessageCount}</div>
                <div className="text-xs text-muted-foreground">Last 30 days</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <Sparkles className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                <div className="text-2xl font-semibold">{memoryStats?.memoriesExtracted ?? 0}</div>
                <div className="text-xs text-muted-foreground">Memories</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <Clock className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
                <div className="text-sm font-medium">
                  {stats.lastContactedAt ? formatRelativeTime(stats.lastContactedAt) : "Never"}
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
                  <div className="text-xs text-muted-foreground mb-1">Company</div>
                  {isEditing ? (
                    <Input
                      value={editForm.company}
                      onChange={(e) => setEditForm((f) => ({ ...f, company: e.target.value }))}
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
                      onChange={(e) => setEditForm((f) => ({ ...f, tags: e.target.value }))}
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
                <div className="text-xs text-muted-foreground mb-2">Contact Methods</div>
                <div className="space-y-2">
                  {contact.handles.map((handle, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm">
                      <HandleIcon type={handle.type} />
                      <span className="flex-1 font-mono text-sm">{handle.value}</span>
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
                  onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Add notes about this contact..."
                  rows={4}
                />
              ) : contact.notes ? (
                <p className="text-sm whitespace-pre-wrap">{contact.notes}</p>
              ) : (
                <p className="text-sm text-muted-foreground">No notes yet. Click edit to add some.</p>
              )}
            </CardContent>
          </Card>

          {/* AI Memories */}
          <Card>
            <CardHeader
              className="pb-3 cursor-pointer"
              onClick={() => setMemoriesExpanded(!memoriesExpanded)}
            >
              <div className="flex items-center justify-between">
                <h2 className="font-semibold flex items-center gap-2">
                  <Lightbulb className="w-4 h-4" />
                  What I Know
                  {memories.length > 0 && (
                    <Badge variant="secondary" className="ml-2">
                      {memories.length}
                    </Badge>
                  )}
                </h2>
                {memoriesExpanded ? (
                  <ChevronUp className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
            </CardHeader>
            {memoriesExpanded && (
              <CardContent>
                {memoriesLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading memories...
                  </div>
                ) : memories.length > 0 ? (
                  <ul className="space-y-2">
                    {memories.map((m, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <Sparkles className="w-3 h-3 mt-1 text-amber-500 shrink-0" />
                        <span>{m.memory}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No memories extracted yet. Memories are automatically learned from conversations.
                  </p>
                )}
              </CardContent>
            )}
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
                  <p className="text-sm text-muted-foreground">No messages yet.</p>
                )}
              </CardContent>
            )}
          </Card>
        </div>
      </div>

      {/* Send Message Modal */}
      <SendMessageModal
        open={sendModalOpen}
        onOpenChange={setSendModalOpen}
        contact={sendContact}
        onSend={handleSendMessage}
      />
    </div>
  )
}
