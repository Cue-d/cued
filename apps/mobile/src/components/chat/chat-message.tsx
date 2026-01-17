import { useMemo } from "react";
import { ActivityIndicator } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";

import { View, Text } from "@/tw";
import { cn } from "@/lib/utils";

// Types matching web implementation
export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  state: "partial-call" | "call" | "result";
  result?: unknown;
}

export interface ChatMessageData {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolInvocations?: ToolInvocation[];
}

interface ChatMessageProps {
  message: ChatMessageData;
  isStreaming?: boolean;
}

/**
 * Simple markdown renderer for assistant messages.
 * Supports: **bold**, `code`
 */
function renderMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Match **bold**
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      parts.push(
        <Text key={key++} className="font-bold">
          {boldMatch[1]}
        </Text>
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Match `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(
        <Text
          key={key++}
          className="font-mono bg-sf-fill px-1 py-0.5 rounded text-sm"
        >
          {codeMatch[1]}
        </Text>
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Find next special character or end
    const nextSpecial = remaining.search(/\*\*|`/);
    if (nextSpecial === -1) {
      // No more special characters, add rest as plain text
      parts.push(<Text key={key++}>{remaining}</Text>);
      break;
    } else if (nextSpecial > 0) {
      // Add plain text before next special character
      parts.push(<Text key={key++}>{remaining.slice(0, nextSpecial)}</Text>);
      remaining = remaining.slice(nextSpecial);
    } else {
      // Special character at start but no match, add it as plain text
      parts.push(<Text key={key++}>{remaining[0]}</Text>);
      remaining = remaining.slice(1);
    }
  }

  return parts;
}

function TypingIndicator() {
  return (
    <View className="flex-row items-center gap-1">
      <ActivityIndicator size="small" color="#8E8E93" />
      <Text className="text-sf-secondaryLabel text-sm">Thinking...</Text>
    </View>
  );
}

function PendingToolIndicator({ toolName }: { toolName: string }) {
  const displayName = toolName.replace(/_/g, " ");
  return (
    <View className="flex-row items-center gap-2 mt-2">
      <ActivityIndicator size="small" color="#8E8E93" />
      <Text className="text-sf-secondaryLabel text-xs">
        Using {displayName}...
      </Text>
    </View>
  );
}

function Avatar({ isUser }: { isUser: boolean }) {
  return (
    <View
      className={cn(
        "w-8 h-8 rounded-full items-center justify-center",
        isUser ? "bg-sf-blue" : "bg-sf-fill"
      )}
    >
      <Text
        className={cn(
          "text-xs font-medium",
          isUser ? "text-white" : "text-sf-secondaryLabel"
        )}
      >
        {isUser ? "U" : "AI"}
      </Text>
    </View>
  );
}

export function ChatMessage({ message, isStreaming = false }: ChatMessageProps) {
  const isUser = message.role === "user";

  // Get pending tool calls
  const pendingToolCalls = useMemo(() => {
    if (!message.toolInvocations) return [];
    return message.toolInvocations.filter(
      (inv) => inv.state === "call" || inv.state === "partial-call"
    );
  }, [message.toolInvocations]);

  const content = message.content;
  const showTypingIndicator = isStreaming && !content && isUser === false;

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      className={cn(
        "flex-row gap-3 py-2 px-4",
        isUser ? "flex-row-reverse" : "flex-row"
      )}
    >
      <Avatar isUser={isUser} />

      <View
        className={cn(
          "max-w-[80%] flex-shrink",
          isUser ? "items-end" : "items-start"
        )}
      >
        {/* Message bubble */}
        <View
          className={cn(
            "rounded-2xl px-4 py-3",
            isUser
              ? "bg-sf-blue rounded-br-md"
              : "bg-sf-fill rounded-bl-md"
          )}
        >
          {showTypingIndicator ? (
            <TypingIndicator />
          ) : content ? (
            <Text
              className={cn(
                "text-[15px] leading-relaxed",
                isUser ? "text-white" : "text-sf-label"
              )}
            >
              {isUser ? content : renderMarkdown(content)}
            </Text>
          ) : null}
        </View>

        {/* Pending tool calls */}
        {pendingToolCalls.map((inv) => (
          <PendingToolIndicator key={inv.toolCallId} toolName={inv.toolName} />
        ))}
      </View>
    </Animated.View>
  );
}
