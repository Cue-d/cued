export interface ImsHandle {
  id: number;
  identifier: string;
  service: string;
}

export interface ImsChat {
  id: number;
  identifier: string;
  displayName: string | null;
  isGroup: boolean;
  participants: ImsHandle[];
}

export interface ImsReaction {
  emoji: string;
  reactorIdentifier: string;
  isFromMe: boolean;
  timestamp: number;
}

export interface ImsMessage {
  id: number;
  guid: string;
  chatId: number;
  itemType?: number;
  text: string | null;
  timestamp: number;
  isFromMe: boolean;
  isRead: boolean;
  readAt: number | null;
  status: "sending" | "sent" | "delivered" | "read" | "failed";
  errorCode: number;
  hasAttachments: boolean;
  sender: ImsHandle | null;
  reactions: ImsReaction[];
}

export interface ImsSyncBatch {
  cursor: number;
  fetchedCount: number;
  chats: ImsChat[];
  messages: ImsMessage[];
  handles: ImsHandle[];
}
