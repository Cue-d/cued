import { useMemo } from "react";
import { ActivityIndicator } from "react-native";
import { FadeInUp } from "react-native-reanimated";

import { View, Text } from "react-native";
import { AnimatedView } from "@/components/animated";
import { ToolArtifacts } from "./tool-artifact";

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
        <Text key={key++} className="font-semibold">
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
          className="font-mono bg-muted px-1 rounded text-sm"
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
    <View className="flex-row items-center gap-1.5 py-1">
      <ActivityIndicator size="small" color="#8E8E93" />
      <Text className="text-muted-foreground text-sm">Thinking...</Text>
    </View>
  );
}

function PendingToolIndicator({ toolName }: { toolName: string }) {
  const displayName = toolName.replace(/_/g, " ");
  return (
    <View className="flex-row items-center gap-2 mt-2">
      <ActivityIndicator size="small" color="#8E8E93" />
      <Text className="text-muted-foreground text-xs">
        Using {displayName}...
      </Text>
    </View>
  );
}

/**
 * User message - right-aligned bubble with distinctive corner
 * Based on expo-ai design
 */
function UserMessage({ content }: { content: string }) {
  return (
    <View className="flex-row justify-end px-4 py-1">
      <View className="max-w-[85%]">
        <View className="bg-white border border-border rounded-[20px] rounded-br-[8px] p-3">
          <Text selectable className="text-black text-[16px]">
            {content}
          </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * Assistant message - left-aligned with subtle gray prefix
 * Based on expo-ai design
 */
function AssistantMessage({
  content,
  isStreaming,
  pendingToolCalls,
  toolInvocations,
}: {
  content: string;
  isStreaming: boolean;
  pendingToolCalls: ToolInvocation[];
  toolInvocations?: ToolInvocation[];
}) {
  const showTypingIndicator = isStreaming && !content;

  return (
    <View className="px-4 py-1">
      {showTypingIndicator ? (
        <TypingIndicator />
      ) : content ? (
        <Text className="text-foreground text-[16px] leading-relaxed">
          <Text className="text-muted-foreground">{"> "}</Text>
          {renderMarkdown(content)}
        </Text>
      ) : null}

      {/* Pending tool calls */}
      {pendingToolCalls.map((inv) => (
        <PendingToolIndicator key={inv.toolCallId} toolName={inv.toolName} />
      ))}

      {/* Completed tool call artifacts */}
      {toolInvocations && <ToolArtifacts toolInvocations={toolInvocations} />}
    </View>
  );
}

export function ChatMessage({
  message,
  isStreaming = false,
}: ChatMessageProps) {
  const isUser = message.role === "user";

  // Get pending tool calls
  const pendingToolCalls = useMemo(() => {
    if (!message.toolInvocations) return [];
    return message.toolInvocations.filter(
      (inv) => inv.state === "call" || inv.state === "partial-call"
    );
  }, [message.toolInvocations]);

  return (
    <AnimatedView entering={FadeInUp.duration(300).springify()}>
      {isUser ? (
        <UserMessage content={message.content} />
      ) : (
        <AssistantMessage
          content={message.content}
          isStreaming={isStreaming}
          pendingToolCalls={pendingToolCalls}
          toolInvocations={message.toolInvocations}
        />
      )}
    </AnimatedView>
  );
}
