import { Text, VStack } from "@expo/ui/swift-ui";
import {
  font,
  foregroundStyle,
  padding,
  frame,
  background,
} from "@expo/ui/swift-ui/modifiers";
import type { WidgetBase } from "expo-widgets";

export interface ActionCountWidgetProps {
  count: number;
}

/**
 * Widget displaying the pending action count.
 * Adapts layout based on widget family (systemSmall vs systemMedium).
 */
export function ActionCountWidget(
  props: WidgetBase<ActionCountWidgetProps>
): React.JSX.Element {
  const { count, family } = props;
  const isSmall = family === "systemSmall";

  return (
    <VStack
      modifiers={[
        padding({ all: 16 }),
        frame({ maxWidth: Infinity, maxHeight: Infinity }),
        background("rgba(0, 122, 255, 0.05)"),
      ]}
    >
      <Text
        modifiers={[
          font({ weight: "bold", size: isSmall ? 48 : 64, design: "rounded" }),
          foregroundStyle("primary"),
        ]}
      >
        {count}
      </Text>
      <Text
        modifiers={[
          font({ weight: "medium", size: isSmall ? 14 : 16 }),
          foregroundStyle("secondary"),
        ]}
      >
        {count === 1 ? "Action" : "Actions"}
      </Text>
      {count > 0 && (
        <Text
          modifiers={[
            font({ size: isSmall ? 10 : 12 }),
            foregroundStyle("#007AFF"),
          ]}
        >
          Tap to review
        </Text>
      )}
    </VStack>
  );
}
