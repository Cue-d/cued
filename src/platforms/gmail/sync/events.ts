import { createHash } from "node:crypto";
import type {
  ContactObservationPayload,
  ConversationObservationPayload,
  MessagePayload,
} from "../../../core/types/provider.js";
import type { SyncBundle } from "../../core/sync.js";
import type { GmailMessage, GmailMessagePayload } from "../api/client.js";

export function gmailStableId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function header(message: GmailMessage, name: string): string | null {
  const match = message.payload?.headers?.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );
  return match?.value ?? null;
}

function decodeMimeData(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function collectBodyParts(payload: GmailMessagePayload | undefined, mimeType: string): string[] {
  if (!payload) return [];
  const current =
    payload.mimeType === mimeType && payload.body?.data ? [decodeMimeData(payload.body.data)] : [];
  return [...current, ...(payload.parts ?? []).flatMap((part) => collectBodyParts(part, mimeType))];
}

function collectAttachmentParts(
  payload: GmailMessagePayload | undefined,
  messageId: string,
): Array<Record<string, unknown>> {
  if (!payload) return [];

  const attachments: Array<Record<string, unknown>> = [];
  const filename = payload.filename?.trim() || null;
  const attachmentId = payload.body?.attachmentId?.trim() || null;
  if (filename || attachmentId) {
    const sourceAttachmentKey = attachmentId
      ? `gmail:${messageId}:attachment:${attachmentId}`
      : `gmail:${messageId}:part:${payload.partId ?? filename}`;
    attachments.push({
      sourceAttachmentKey,
      id: attachmentId ?? payload.partId ?? filename,
      kind: "file",
      filename,
      mime_type: payload.mimeType ?? null,
      size_bytes: payload.body?.size ?? null,
      access_kind: attachmentId ? "provider_fetch" : "none",
      access_ref: attachmentId ? { messageId, attachmentId } : null,
      availability_status: attachmentId ? "available" : "metadata_only",
      provider_metadata: {
        partId: payload.partId ?? null,
      },
    });
  }

  return [
    ...attachments,
    ...(payload.parts ?? []).flatMap((part) => collectAttachmentParts(part, messageId)),
  ];
}

function stripHtml(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractGmailMessageText(message: GmailMessage): string {
  const plain = collectBodyParts(message.payload, "text/plain").join("\n").trim();
  if (plain) return plain;
  const html = collectBodyParts(message.payload, "text/html").join("\n");
  if (html) return stripHtml(html);
  return message.snippet?.trim() ?? "";
}

function parseAddressList(value: string | null): Array<{ name: string | null; email: string }> {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .flatMap((entry) => {
      const bracket = entry.match(/^(.*?)<([^>]+)>$/);
      const rawEmail = bracket ? bracket[2] : entry;
      const email =
        rawEmail
          ?.trim()
          .replace(/^mailto:/i, "")
          .toLowerCase() ?? "";
      if (!email.includes("@")) return [];
      const rawName = bracket?.[1]?.trim().replace(/^"|"$/g, "") ?? null;
      return [{ name: rawName && rawName.length > 0 ? rawName : null, email }];
    });
}

function sourceKey(email: string): string {
  return `gmail:${email}`;
}

function collectParticipants(input: {
  from: Array<{ name: string | null; email: string }>;
  recipients: Array<{ name: string | null; email: string }>;
  selfEmail: string;
}): Map<string, { name: string | null; email: string }> {
  const participants = new Map<string, { name: string | null; email: string }>();
  for (const participant of [
    ...input.from,
    ...input.recipients,
    { name: "Me", email: input.selfEmail },
  ]) {
    participants.set(participant.email, participant);
  }
  return participants;
}

function messageSentAt(message: GmailMessage): number {
  const internalDate = Number(message.internalDate);
  if (Number.isFinite(internalDate) && internalDate > 0) return internalDate;
  const parsedDate = Date.parse(header(message, "date") ?? "");
  return Number.isFinite(parsedDate) ? parsedDate : Date.now();
}

export function buildGmailRawEvents(input: {
  accountKey: string;
  emailAddress: string;
  messages: GmailMessage[];
  observedAt: number;
}): SyncBundle["rawEvents"] {
  const rawEvents: SyncBundle["rawEvents"] = [];
  const selfEmail = input.emailAddress.toLowerCase();
  const conversations = new Map<
    string,
    {
      conversationKey: string;
      conversationId: string;
      subject: string | null;
      participants: Map<string, { name: string | null; email: string }>;
    }
  >();

  for (const message of input.messages) {
    const from = parseAddressList(header(message, "from"));
    const recipients = [
      ...parseAddressList(header(message, "to")),
      ...parseAddressList(header(message, "cc")),
    ];
    const participants = collectParticipants({ from, recipients, selfEmail });

    for (const participant of participants.values()) {
      const id = gmailStableId(`gmail:contact:${input.accountKey}:${participant.email}`);
      rawEvents.push({
        id,
        platform: "gmail",
        accountKey: input.accountKey,
        entityKind: "contact",
        eventKind: "observed",
        externalEntityId: participant.email,
        observedAt: input.observedAt,
        dedupeKey: id,
        payload: {
          sourceEntityKey: sourceKey(participant.email),
          fields: {
            display_name: participant.name ?? participant.email,
          },
          handles: [{ type: "email", value: participant.email, deterministic: true }],
        } satisfies ContactObservationPayload,
        sourceVersion: "gmail-v1",
      });
    }

    const conversationKey = `gmail:${input.emailAddress}:thread:${message.threadId}`;
    const conversationId = gmailStableId(
      `gmail:conversation:${input.accountKey}:${message.threadId}`,
    );
    const subject = header(message, "subject");
    const existingConversation = conversations.get(message.threadId);
    if (existingConversation) {
      for (const participant of participants.values()) {
        existingConversation.participants.set(participant.email, participant);
      }
      existingConversation.subject ??= subject;
    } else {
      conversations.set(message.threadId, {
        conversationKey,
        conversationId,
        subject,
        participants,
      });
    }

    const sender = from[0]?.email ?? selfEmail;
    const content = extractGmailMessageText(message);
    const attachments = collectAttachmentParts(message.payload, message.id);
    const sentAt = messageSentAt(message);
    const rawMessageId = gmailStableId(`gmail:message:${input.accountKey}:${message.id}`);
    rawEvents.push({
      id: rawMessageId,
      platform: "gmail",
      accountKey: input.accountKey,
      entityKind: "message",
      eventKind: "created",
      externalEventId: message.id,
      externalEntityId: message.id,
      conversationExternalId: message.threadId,
      occurredAt: sentAt,
      observedAt: input.observedAt,
      dedupeKey: rawMessageId,
      payload: {
        sourceMessageKey: `gmail:${input.emailAddress}:message:${message.id}`,
        sourceConversationKey: conversationKey,
        senderSourceKey: sourceKey(sender),
        sentAt,
        content: subject ? `Subject: ${subject}\n\n${content}` : content,
        service: "gmail",
        isFromMe: sender === selfEmail,
        attachments,
      } satisfies MessagePayload,
      sourceVersion: "gmail-v1",
    });
  }

  for (const [threadId, conversation] of conversations) {
    rawEvents.push({
      id: conversation.conversationId,
      platform: "gmail",
      accountKey: input.accountKey,
      entityKind: "conversation",
      eventKind: "observed",
      conversationExternalId: threadId,
      observedAt: input.observedAt,
      dedupeKey: conversation.conversationId,
      payload: {
        sourceConversationKey: conversation.conversationKey,
        conversationType: conversation.participants.size > 2 ? "group" : "dm",
        displayName: conversation.subject,
        nativeConversationKey: threadId,
        service: "gmail",
        participants: [...conversation.participants.values()].map((participant) => ({
          sourceEntityKey: sourceKey(participant.email),
          isSelf: participant.email === selfEmail,
        })),
      } satisfies ConversationObservationPayload,
      sourceVersion: "gmail-v1",
    });
  }

  return rawEvents;
}
