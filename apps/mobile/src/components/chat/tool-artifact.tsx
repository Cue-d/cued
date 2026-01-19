import { useMemo } from "react";
import { SymbolView } from "expo-symbols";
import type { SFSymbol } from "sf-symbols-typescript";
import { FadeIn } from "react-native-reanimated";
import { isLiquidGlassAvailable, GlassView } from "expo-glass-effect";

import { View, Text, useColorScheme } from "react-native";
import { AnimatedView } from "@/components/animated";
import { getThemeColors } from "@/lib/utils";
import type { ToolInvocation } from "./chat-message";

// Types matching web implementation
interface SearchMessageResult {
  _id: string;
  content: string;
  sentAt: number;
  conversationId: string;
  platform: string;
  isFromMe: boolean;
  senderName?: string;
}

interface ContactResult {
  _id: string;
  displayName: string;
  company?: string | null;
  handles: {
    type: string;
    value: string;
    platform: string;
  }[];
}

interface ActionCreatedResult {
  actionId: string;
  type: string;
  priority: number;
  reason?: string;
}

// Helper to format relative time
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

// Platform icon mapping
function getPlatformIcon(platform: string): SFSymbol {
  switch (platform.toLowerCase()) {
    case "imessage":
      return "message.fill";
    case "gmail":
    case "email":
      return "envelope.fill";
    case "slack":
      return "number";
    default:
      return "message.fill";
  }
}

function getPlatformColor(platform: string): string {
  switch (platform.toLowerCase()) {
    case "imessage":
      return "#34C759"; // green
    case "gmail":
    case "email":
      return "#EA4335"; // red
    case "slack":
      return "#611F69"; // purple
    default:
      return "#8E8E93"; // gray
  }
}

// Artifact Header
function ArtifactHeader({
  icon,
  label,
  isEmpty,
  emptyMessage,
  mutedColor,
}: {
  icon: SFSymbol;
  label: string;
  isEmpty: boolean;
  emptyMessage: string;
  mutedColor: string;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <SymbolView name={icon} size={14} tintColor={mutedColor} />
      <Text className="text-xs font-medium text-muted-foreground">
        {isEmpty ? emptyMessage : label}
      </Text>
    </View>
  );
}

// Glass-styled card container
function ArtifactCard({ children }: { children: React.ReactNode }) {
  const useGlass = isLiquidGlassAvailable();

  if (useGlass) {
    return (
      <GlassView className="rounded-xl overflow-hidden p-3">
        {children}
      </GlassView>
    );
  }

  return (
    <View className="rounded-xl bg-muted/50 p-3">{children}</View>
  );
}

// Search Messages Artifact
function SearchMessagesArtifact({ data, mutedColor }: { data: SearchMessageResult[]; mutedColor: string }) {
  if (data.length === 0) {
    return (
      <ArtifactHeader
        icon="magnifyingglass"
        label=""
        isEmpty={true}
        emptyMessage="No messages found"
        mutedColor={mutedColor}
      />
    );
  }

  return (
    <View className="gap-2">
      <ArtifactHeader
        icon="magnifyingglass"
        label={`${data.length} message${data.length > 1 ? "s" : ""} found`}
        isEmpty={false}
        emptyMessage=""
        mutedColor={mutedColor}
      />
      <View className="gap-1.5">
        {data.slice(0, 5).map((result) => (
          <ArtifactCard key={result._id}>
            <View className="flex-row items-center gap-2 mb-1">
              <SymbolView
                name={getPlatformIcon(result.platform)}
                size={12}
                tintColor={getPlatformColor(result.platform)}
              />
              <Text className="text-xs font-medium text-foreground">
                {result.isFromMe ? "You" : result.senderName || "Unknown"}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {formatRelativeTime(result.sentAt)}
              </Text>
            </View>
            <Text className="text-sm text-foreground" numberOfLines={2}>
              {result.content}
            </Text>
          </ArtifactCard>
        ))}
        {data.length > 5 && (
          <Text className="text-xs text-muted-foreground mt-1">
            +{data.length - 5} more results
          </Text>
        )}
      </View>
    </View>
  );
}

// Search Contacts Artifact
function SearchContactsArtifact({ data, mutedColor }: { data: ContactResult[]; mutedColor: string }) {
  if (data.length === 0) {
    return (
      <ArtifactHeader
        icon="person.2"
        label=""
        isEmpty={true}
        emptyMessage="No contacts found"
        mutedColor={mutedColor}
      />
    );
  }

  return (
    <View className="gap-2">
      <ArtifactHeader
        icon="person.2"
        label={`${data.length} contact${data.length > 1 ? "s" : ""} found`}
        isEmpty={false}
        emptyMessage=""
        mutedColor={mutedColor}
      />
      <View className="gap-1.5">
        {data.map((contact) => (
          <ArtifactCard key={contact._id}>
            <View className="flex-row items-center gap-3">
              {/* Avatar */}
              <View className="w-8 h-8 rounded-full bg-primary/20 items-center justify-center">
                <Text className="text-xs font-semibold text-primary">
                  {contact.displayName
                    .split(" ")
                    .map((n) => n[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase()}
                </Text>
              </View>
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">
                  {contact.displayName}
                </Text>
                {contact.company && (
                  <Text className="text-xs text-muted-foreground">
                    {contact.company}
                  </Text>
                )}
                {contact.handles.length > 0 && (
                  <View className="flex-row flex-wrap gap-1 mt-1">
                    {contact.handles.slice(0, 3).map((handle, i) => (
                      <View
                        key={i}
                        className="flex-row items-center gap-1 bg-muted rounded-full px-2 py-0.5"
                      >
                        <SymbolView
                          name={getPlatformIcon(handle.platform)}
                          size={10}
                          tintColor={getPlatformColor(handle.platform)}
                        />
                        <Text
                          className="text-[10px] text-muted-foreground max-w-[80px]"
                          numberOfLines={1}
                        >
                          {handle.value}
                        </Text>
                      </View>
                    ))}
                    {contact.handles.length > 3 && (
                      <View className="bg-muted rounded-full px-2 py-0.5">
                        <Text className="text-[10px] text-muted-foreground">
                          +{contact.handles.length - 3}
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            </View>
          </ArtifactCard>
        ))}
      </View>
    </View>
  );
}

// Action Created Artifact
function ActionCreatedArtifact({ data, mutedColor, successColor }: { data: ActionCreatedResult; mutedColor: string; successColor: string }) {
  return (
    <View className="gap-2">
      <ArtifactHeader
        icon="checkmark.circle.fill"
        label="Action created"
        isEmpty={false}
        emptyMessage=""
        mutedColor={mutedColor}
      />
      <View className="rounded-xl bg-green-500/10 p-3 border border-green-500/20">
        <View className="flex-row items-center gap-3">
          <View className="w-8 h-8 rounded-full bg-green-500/20 items-center justify-center">
            <SymbolView name="checkmark" size={16} tintColor={successColor} />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-medium text-green-600 dark:text-green-500">
              Action created
            </Text>
            <Text className="text-xs text-muted-foreground">
              {data.type.replace(/_/g, " ")} - Priority {data.priority}
            </Text>
          </View>
        </View>
        {data.reason && (
          <Text className="text-sm text-foreground mt-2">{data.reason}</Text>
        )}
      </View>
    </View>
  );
}

// Parse tool results based on tool name
function parseToolResult(
  toolName: string,
  result: unknown
): { type: "messages" | "contacts" | "action"; data: unknown } | null {
  if (!result || typeof result !== "object") return null;
  const data = result as Record<string, unknown>;

  switch (toolName) {
    case "search_messages":
      if (Array.isArray(data.results)) {
        return { type: "messages", data: data.results as SearchMessageResult[] };
      }
      return null;

    case "search_contacts":
      if (Array.isArray(data.results)) {
        return { type: "contacts", data: data.results as ContactResult[] };
      }
      return null;

    case "create_action":
      if (data.actionId) {
        return {
          type: "action",
          data: {
            actionId: data.actionId as string,
            type: (data.type as string) || "unknown",
            priority: (data.priority as number) || 50,
            reason: data.reason as string | undefined,
          } as ActionCreatedResult,
        };
      }
      return null;

    default:
      return null;
  }
}

// Main ToolArtifact component
interface ToolArtifactProps {
  toolName: string;
  result: unknown;
}

export function ToolArtifact({ toolName, result }: ToolArtifactProps) {
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");
  const parsed = useMemo(
    () => parseToolResult(toolName, result),
    [toolName, result]
  );

  if (!parsed) return null;

  return (
    <AnimatedView entering={FadeIn.duration(200)} className="mt-2">
      {parsed.type === "messages" && (
        <SearchMessagesArtifact data={parsed.data as SearchMessageResult[]} mutedColor={colors.mutedForeground} />
      )}
      {parsed.type === "contacts" && (
        <SearchContactsArtifact data={parsed.data as ContactResult[]} mutedColor={colors.mutedForeground} />
      )}
      {parsed.type === "action" && (
        <ActionCreatedArtifact data={parsed.data as ActionCreatedResult} mutedColor={colors.mutedForeground} successColor={colors.success} />
      )}
    </AnimatedView>
  );
}

// Export for rendering completed tool invocations
export function ToolArtifacts({
  toolInvocations,
}: {
  toolInvocations: ToolInvocation[];
}) {
  const completedTools = toolInvocations.filter(
    (inv) => inv.state === "result" && inv.result !== undefined
  );

  if (completedTools.length === 0) return null;

  return (
    <View className="gap-2">
      {completedTools.map((inv) => (
        <ToolArtifact
          key={inv.toolCallId}
          toolName={inv.toolName}
          result={inv.result}
        />
      ))}
    </View>
  );
}
