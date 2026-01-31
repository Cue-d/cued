import { Platform } from "react-native";
import { updateWidgetSnapshot } from "expo-widgets";
import {
  ActionCountWidget,
  ActionsListWidget,
  type WidgetAction,
} from "@/widgets";

export type { WidgetAction };

/**
 * Updates the ActionCountWidget with the current pending action count.
 * Uses expo-widgets to render JSX directly to the widget.
 */
export function updateWidgetData(actionCount: number): void {
  if (Platform.OS !== "ios") {
    return;
  }

  try {
    updateWidgetSnapshot("ActionCountWidget", ActionCountWidget, {
      count: actionCount,
    });
  } catch (error) {
    console.warn("[Widget] Failed to update widget data:", error);
  }
}

/**
 * Updates the ActionsListWidget with current actions.
 * Limited to 5 items to keep widget performant.
 */
export function updateWidgetActionsList(actions: WidgetAction[]): void {
  if (Platform.OS !== "ios") {
    return;
  }

  try {
    const limitedActions = actions.slice(0, 5);
    updateWidgetSnapshot("ActionsListWidget", ActionsListWidget, {
      actions: limitedActions,
    });
  } catch (error) {
    console.warn("[Widget] Failed to update actions list:", error);
  }
}
