export interface WhatsAppContactSnapshot {
  jid: string;
  phone?: string | null;
  name?: string | null;
  pushName?: string | null;
}

export interface WhatsAppChatSnapshot {
  jid: string;
  name?: string | null;
  isGroup: boolean;
  participants?: string[];
}

export interface WhatsAppMessageSnapshot {
  messageID: string;
  chatJID: string;
  senderJID?: string | null;
  participantJID?: string | null;
  fromMe: boolean;
  timestamp: number;
  text: string;
  pushName?: string | null;
  status?: string | null;
  deliveredAt?: number | null;
  readAt?: number | null;
  attachments?: Array<Record<string, unknown>>;
}

export interface WhatsAppReceiptSnapshot {
  messageID: string;
  chatJID: string;
  fromMe: boolean;
  status?: string | null;
  deliveredAt?: number | null;
  readAt?: number | null;
}

export interface WhatsAppSnapshot {
  contacts?: WhatsAppContactSnapshot[];
  chats?: WhatsAppChatSnapshot[];
  messages?: WhatsAppMessageSnapshot[];
}

export interface WhatsAppResyncPage extends WhatsAppSnapshot {
  nextCursor?: string | null;
  hasMore: boolean;
  completedAt: number;
}

export type WhatsAppHelperEventName =
  | "connected"
  | "contact_upsert"
  | "chat_upsert"
  | "message_upsert"
  | "receipt_update"
  | "history_sync"
  | "disconnected"
  | "error";

export type WhatsAppHelperEventData = {
  connected: {
    accountJid: string;
    pushName?: string | null;
    helperVersion?: string | null;
  };
  contact_upsert: WhatsAppContactSnapshot;
  chat_upsert: WhatsAppChatSnapshot;
  message_upsert: WhatsAppMessageSnapshot;
  receipt_update: WhatsAppReceiptSnapshot;
  history_sync: WhatsAppSnapshot & {
    completedAt?: number | null;
    syncType?: string | null;
    chunkOrder?: number | null;
    progress?: number | null;
    queuedHistorySyncCount?: number | null;
    lastHistorySyncError?: string | null;
    lastHistoryNotificationAt?: number | null;
  };
  disconnected: {
    reason?: string | null;
  };
  error: {
    message: string;
  };
};

export interface WhatsAppHelperEventEnvelope<
  TEvent extends WhatsAppHelperEventName = WhatsAppHelperEventName,
> {
  event: TEvent;
  data: WhatsAppHelperEventData[TEvent];
}

export type WhatsAppHelperCommand =
  | {
      id: number;
      command: "sendText";
      target: string;
      text: string;
    }
  | {
      id: number;
      command: "resync";
      cursor?: string;
      sinceMs?: number | null;
      limit?: number;
    }
  | {
      id: number;
      command: "downloadMedia";
      chatJID: string;
      messageID: string;
      attachmentIndex?: number;
    }
  | {
      id: number;
      command: "status";
    };

export interface WhatsAppHelperStatusResult {
  accountJid?: string | null;
  pushName?: string | null;
  connected?: boolean;
  helperVersion?: string | null;
  lastHistorySyncAt?: number | null;
  lastHistorySyncType?: string | null;
  lastHistoryChunkOrder?: number | null;
  lastHistoryProgress?: number | null;
  queuedHistorySyncCount?: number | null;
  lastHistorySyncError?: string | null;
  lastHistoryNotificationAt?: number | null;
}

export interface WhatsAppHelperSendResult {
  messageID: string;
  chatJID: string;
  timestamp: number;
}

export interface WhatsAppHelperDownloadResult {
  dataBase64: string;
  mimeType?: string | null;
  filename?: string | null;
  sizeBytes: number;
}

export interface WhatsAppHelperResponseEnvelope<TResult = unknown> {
  id: number;
  ok: boolean;
  result?: TResult;
  error?: string;
}
