/**
 * ChatContext - Shared state for the agent chat.
 *
 * Lifts useChat state so that the NativeTabs.BottomAccessory (which renders
 * the ChatInput on the Agent tab) and the Agent screen can share a single
 * source of truth for messages, input, and loading state.
 */

import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useChat } from "@/hooks/useChat";
import { getAccessToken } from "@/lib/auth";
import type { ChatMessageData } from "@/components/chat/chat-message";

interface ChatContextValue {
  messages: ChatMessageData[];
  input: string;
  setInput: (text: string) => void;
  sendMessage: (content?: string) => Promise<void>;
  isLoading: boolean;
  error: Error | null;
  clearMessages: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const chat = useChat({ getAccessToken });

  const value = useMemo<ChatContextValue>(
    () => ({
      messages: chat.messages,
      input: chat.input,
      setInput: chat.setInput,
      sendMessage: chat.sendMessage,
      isLoading: chat.isLoading,
      error: chat.error,
      clearMessages: chat.clearMessages,
    }),
    [chat.messages, chat.input, chat.setInput, chat.sendMessage, chat.isLoading, chat.error, chat.clearMessages],
  );

  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  );
}

export function useAgentChat(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useAgentChat must be used within a ChatProvider");
  }
  return context;
}
