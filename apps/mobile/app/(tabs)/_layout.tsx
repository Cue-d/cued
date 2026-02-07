import { Platform, useColorScheme } from "react-native";
import { useSegments } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { ActionQueueAccessory } from "@/components/action-queue-accessory";
import { AgentChatAccessory } from "@/components/agent-chat-accessory";
import { ActionQueueProvider } from "@/contexts/action-queue-context";
import { ChatProvider } from "@/contexts/chat-context";
import { getThemeColors } from "@/lib/utils";

/** Inner layout that consumes the action queue context */
function TabsLayoutInner() {
  const segments = useSegments();
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");

  // @ts-expect-error - segments is an array of strings
  const isActionsTab = segments[1] === "(actions)";
  // @ts-expect-error - segments is an array of strings
  const isAgentTab = segments[1] === "(agent)";

  const isIOS26Plus = Platform.OS === "ios" && Number(Platform.Version) >= 26;
  const shouldRenderBottomAccessory = (isActionsTab || isAgentTab) && !isIOS26Plus;

  return (
    <NativeTabs minimizeBehavior="onScrollDown" tintColor={colors.primary}>
      {shouldRenderBottomAccessory && (
        <NativeTabs.BottomAccessory>
          {isAgentTab ? <AgentChatAccessory /> : <ActionQueueAccessory />}
        </NativeTabs.BottomAccessory>
      )}

      <NativeTabs.Trigger name="(actions)">
        <NativeTabs.Trigger.Icon sf={{ default: "tray", selected: "tray.fill" }} />
        <NativeTabs.Trigger.Label>Actions</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="(agent)">
        <NativeTabs.Trigger.Icon sf={{ default: "sparkles", selected: "sparkles" }} />
        <NativeTabs.Trigger.Label>Agent</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="(search)" role="search">
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

export default function TabsLayout() {
  return (
    <ActionQueueProvider>
      <ChatProvider>
        <TabsLayoutInner />
      </ChatProvider>
    </ActionQueueProvider>
  );
}
