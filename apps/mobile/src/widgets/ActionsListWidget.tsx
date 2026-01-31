import { Text, VStack, HStack, Image, Spacer } from "@expo/ui/swift-ui";
import {
  font,
  foregroundStyle,
  padding,
  frame,
  background,
} from "@expo/ui/swift-ui/modifiers";
import type { WidgetBase } from "expo-widgets";
import type { SFSymbol } from "sf-symbols-typescript";

export interface WidgetAction {
  id: string;
  contactName: string;
  platform: string | null;
  type: string;
}

export interface ActionsListWidgetProps {
  actions: WidgetAction[];
}

/** Platform icon mapping for SF Symbols */
function getPlatformIcon(platform: string | null): {
  name: SFSymbol;
  color: string;
} {
  switch (platform) {
    case "imessage":
      return { name: "message.fill", color: "#34C759" };
    case "gmail":
      return { name: "envelope.fill", color: "#FF3B30" };
    case "slack":
      return { name: "number.square.fill", color: "#AF52DE" };
    case "linkedin":
      return { name: "briefcase.fill", color: "#007AFF" };
    case "twitter":
      return { name: "at", color: "#5AC8FA" };
    default:
      return { name: "person.fill", color: "#8E8E93" };
  }
}

function ActionRow({
  action,
}: {
  action: WidgetAction;
}): React.JSX.Element {
  const icon = getPlatformIcon(action.platform);

  return (
    <HStack modifiers={[frame({ maxWidth: Infinity })]}>
      <Image
        systemName={icon.name}
        size={14}
        color={icon.color}
        modifiers={[frame({ width: 20 })]}
      />
      <Text
        modifiers={[
          font({ weight: "medium", size: 14 }),
          foregroundStyle("primary"),
        ]}
      >
        {action.contactName}
      </Text>
      <Spacer />
    </HStack>
  );
}

function EmptyView(): React.JSX.Element {
  return (
    <VStack>
      <Image
        systemName="checkmark.circle.fill"
        size={32}
        color="#34C759"
      />
      <Text
        modifiers={[font({ weight: "medium", size: 14 }), foregroundStyle("primary")]}
      >
        All caught up!
      </Text>
    </VStack>
  );
}

/**
 * Widget displaying a list of contacts to reply to.
 * Adapts number of visible items based on widget family.
 */
export function ActionsListWidget(
  props: WidgetBase<ActionsListWidgetProps>
): React.JSX.Element {
  const { actions, family } = props;

  const maxItems =
    family === "systemSmall" ? 3 : family === "systemMedium" ? 4 : 8;

  const visibleActions = actions.slice(0, maxItems);
  const remainingCount = actions.length - maxItems;

  if (actions.length === 0) {
    return (
      <VStack
        modifiers={[
          padding({ all: 12 }),
          frame({ maxWidth: Infinity, maxHeight: Infinity }),
          background("white"),
        ]}
      >
        <EmptyView />
      </VStack>
    );
  }

  return (
    <VStack
      modifiers={[
        padding({ all: 12 }),
        frame({ maxWidth: Infinity, maxHeight: Infinity }),
        background("white"),
      ]}
    >
      <HStack modifiers={[frame({ maxWidth: Infinity })]}>
        <Text
          modifiers={[
            font({ weight: "semibold", size: 12 }),
            foregroundStyle("secondary"),
          ]}
        >
          REPLY TO
        </Text>
        <Spacer />
        {remainingCount > 0 && (
          <Text
            modifiers={[
              font({ weight: "medium", size: 11 }),
              foregroundStyle("secondary"),
            ]}
          >
            +{remainingCount}
          </Text>
        )}
      </HStack>
      <VStack modifiers={[padding({ top: 8 })]}>
        {visibleActions.map((action) => (
          <ActionRow key={action.id} action={action} />
        ))}
      </VStack>
      <Spacer />
    </VStack>
  );
}
