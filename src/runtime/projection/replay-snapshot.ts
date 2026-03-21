import { sql } from "drizzle-orm";
import type { CuedDatabase } from "../../db/database.js";

export type CanonicalProjectionSnapshot = {
  contacts: Array<{
    id: string;
    name: string | null;
    photoUrl: string | null;
    company: string | null;
    archived: number;
    handles: Array<{
      type: string;
      value: string;
      normalizedValue: string;
      isDeterministic: number;
    }>;
    sources: Array<{
      platform: string;
      accountKey: string;
      sourceEntityKey: string;
      profileUrl: string | null;
    }>;
  }>;
  conversations: Array<{
    id: string;
    platform: string;
    accountKey: string;
    sourceConversationKey: string;
    type: string;
    name: string | null;
    participantNames: string | null;
    unreadCount: number;
  }>;
  conversationParticipants: Array<{
    conversationId: string;
    contactId: string;
    participantName: string | null;
    isSelf: number;
    isActive: number;
  }>;
  messages: Array<{
    id: string;
    platform: string;
    accountKey: string;
    platformMessageId: string;
    conversationId: string;
    senderName: string | null;
    conversationName: string | null;
    sentAt: number;
    content: string | null;
    status: string | null;
    readAt: number | null;
    editedAt: number | null;
    isEdited: number;
    isFromMe: number;
    attachmentCount: number;
    reactionCount: number;
    replyToMessageId: string | null;
  }>;
  messageAttachments: Array<{
    id: string;
    messageId: string;
    sourceAttachmentKey: string;
    filename: string | null;
    title: string | null;
    localPath: string | null;
    remoteUrl: string | null;
    availabilityStatus: string | null;
  }>;
  messageReactions: Array<{
    id: string;
    messageId: string;
    emoji: string;
    isActive: number;
    reactorName: string | null;
  }>;
  timelineEvents: Array<{
    id: string;
    conversationId: string;
    sourceEventKey: string;
    eventKind: string;
    text: string | null;
  }>;
  ftsMessageIds: string[];
};

export function readCanonicalProjectionSnapshot(db: CuedDatabase): CanonicalProjectionSnapshot {
  const contacts = db.orm().all<{
    id: string;
    name: string | null;
    photoUrl: string | null;
    company: string | null;
    archived: number;
  }>(sql`
    SELECT id, name, photo_url as photoUrl, company, archived
    FROM contacts
    ORDER BY id ASC
  `);

  const contactHandles = db.orm().all<{
    contact_id: string;
    type: string;
    value: string;
    normalized_value: string;
    is_deterministic: number;
  }>(sql`
    SELECT contact_id, type, value, normalized_value, is_deterministic
    FROM contact_handles
    ORDER BY contact_id ASC, type ASC, value ASC
  `);

  const contactSources = db.orm().all<{
    contact_id: string;
    platform: string;
    account_key: string;
    source_entity_key: string;
    profile_url: string | null;
  }>(sql`
    SELECT contact_id, platform, account_key, source_entity_key, profile_url
    FROM contact_sources
    ORDER BY contact_id ASC, platform ASC, account_key ASC, source_entity_key ASC
  `);

  const conversations = db.orm().all<{
    id: string;
    platform: string;
    account_key: string;
    source_conversation_key: string;
    type: string;
    name: string | null;
    participant_names: string | null;
    unread_count: number;
  }>(sql`
    SELECT id, platform, account_key, source_conversation_key, type, name, participant_names, unread_count
    FROM conversations
    ORDER BY id ASC
  `);

  const messages = db.orm().all<{
    id: string;
    platform: string;
    account_key: string;
    platform_message_id: string;
    conversation_id: string;
    sender_name: string | null;
    conversation_name: string | null;
    sent_at: number;
    content: string | null;
    status: string | null;
    read_at: number | null;
    edited_at: number | null;
    is_edited: number;
    is_from_me: number;
    attachment_count: number;
    reaction_count: number;
    reply_to_message_id: string | null;
  }>(sql`
    SELECT id, platform, account_key, platform_message_id, conversation_id, sender_name, conversation_name, sent_at, content, status, read_at, edited_at, is_edited, is_from_me, attachment_count, reaction_count, reply_to_message_id
    FROM messages
    ORDER BY id ASC
  `);

  const conversationParticipants = db.orm().all<{
    conversation_id: string;
    contact_id: string;
    participant_name: string | null;
    is_self: number;
    is_active: number;
  }>(sql`
    SELECT conversation_id, contact_id, participant_name, is_self, is_active
    FROM conversation_participants
    ORDER BY conversation_id ASC, contact_id ASC
  `);

  const messageAttachments = db.orm().all<{
    id: string;
    message_id: string;
    source_attachment_key: string;
    filename: string | null;
    title: string | null;
    local_path: string | null;
    remote_url: string | null;
    availability_status: string | null;
  }>(sql`
    SELECT id, message_id, source_attachment_key, filename, title, local_path, remote_url, availability_status
    FROM message_attachments
    ORDER BY id ASC
  `);

  const messageReactions = db.orm().all<{
    id: string;
    message_id: string;
    emoji: string;
    is_active: number;
    reactor_name: string | null;
  }>(sql`
    SELECT id, message_id, emoji, is_active, reactor_name
    FROM message_reactions
    ORDER BY id ASC
  `);

  const timelineEvents = db.orm().all<{
    id: string;
    conversation_id: string;
    source_event_key: string;
    event_kind: string;
    text: string | null;
  }>(sql`
    SELECT id, conversation_id, source_event_key, event_kind, text
    FROM timeline_events
    ORDER BY id ASC
  `);

  const ftsMessageIds = db
    .orm()
    .all<{ message_id: string }>(sql`
      SELECT message_id
      FROM messages_fts
      ORDER BY message_id ASC
    `)
    .map((row) => row.message_id);

  return {
    contacts: contacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      photoUrl: contact.photoUrl,
      company: contact.company,
      archived: contact.archived,
      handles: contactHandles
        .filter((handle) => handle.contact_id === contact.id)
        .map((handle) => ({
          type: handle.type,
          value: handle.value,
          normalizedValue: handle.normalized_value,
          isDeterministic: handle.is_deterministic,
        })),
      sources: contactSources
        .filter((source) => source.contact_id === contact.id)
        .map((source) => ({
          platform: source.platform,
          accountKey: source.account_key,
          sourceEntityKey: source.source_entity_key,
          profileUrl: source.profile_url,
        })),
    })),
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      platform: conversation.platform,
      accountKey: conversation.account_key,
      sourceConversationKey: conversation.source_conversation_key,
      type: conversation.type,
      name: conversation.name,
      participantNames: conversation.participant_names,
      unreadCount: conversation.unread_count,
    })),
    conversationParticipants: conversationParticipants.map((participant) => ({
      conversationId: participant.conversation_id,
      contactId: participant.contact_id,
      participantName: participant.participant_name,
      isSelf: participant.is_self,
      isActive: participant.is_active,
    })),
    messages: messages.map((message) => ({
      id: message.id,
      platform: message.platform,
      accountKey: message.account_key,
      platformMessageId: message.platform_message_id,
      conversationId: message.conversation_id,
      senderName: message.sender_name,
      conversationName: message.conversation_name,
      sentAt: message.sent_at,
      content: message.content,
      status: message.status,
      readAt: message.read_at,
      editedAt: message.edited_at,
      isEdited: message.is_edited,
      isFromMe: message.is_from_me,
      attachmentCount: message.attachment_count,
      reactionCount: message.reaction_count,
      replyToMessageId: message.reply_to_message_id,
    })),
    messageAttachments: messageAttachments.map((attachment) => ({
      id: attachment.id,
      messageId: attachment.message_id,
      sourceAttachmentKey: attachment.source_attachment_key,
      filename: attachment.filename,
      title: attachment.title,
      localPath: attachment.local_path,
      remoteUrl: attachment.remote_url,
      availabilityStatus: attachment.availability_status,
    })),
    messageReactions: messageReactions.map((reaction) => ({
      id: reaction.id,
      messageId: reaction.message_id,
      emoji: reaction.emoji,
      isActive: reaction.is_active,
      reactorName: reaction.reactor_name,
    })),
    timelineEvents: timelineEvents.map((event) => ({
      id: event.id,
      conversationId: event.conversation_id,
      sourceEventKey: event.source_event_key,
      eventKind: event.event_kind,
      text: event.text,
    })),
    ftsMessageIds,
  };
}
