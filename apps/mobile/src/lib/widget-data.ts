import { ExtensionStorage } from "@bacons/apple-targets";
import { Platform } from "react-native";

const APP_GROUP_ID = "group.com.prm.mobile";
const PENDING_ACTION_COUNT_KEY = "pendingActionCount";
const ACTIONS_LIST_KEY = "actionsList";

// ExtensionStorage instance for App Group shared storage
const storage =
  Platform.OS === "ios" ? new ExtensionStorage(APP_GROUP_ID) : null;

/** Action item for widget display */
export interface WidgetAction {
  id: string;
  contactName: string;
  platform: string | null;
  type: string;
}

/**
 * Updates the pending action count in shared storage for the iOS widget.
 * This writes to UserDefaults via App Groups so the widget can read it.
 */
export function updateWidgetData(actionCount: number): void {
  if (Platform.OS !== "ios" || !storage) {
    return;
  }

  try {
    storage.set(PENDING_ACTION_COUNT_KEY, actionCount);
    // Trigger widget timeline reload so it picks up new data
    ExtensionStorage.reloadWidget("ActionCountWidget");
  } catch (error) {
    console.warn("[Widget] Failed to update widget data:", error);
  }
}

/**
 * Reads the current pending action count from shared storage.
 * Primarily used for debugging/verification.
 */
export function getWidgetData(): number | null {
  if (Platform.OS !== "ios" || !storage) {
    return null;
  }

  try {
    const value = storage.get(PENDING_ACTION_COUNT_KEY);
    return value !== null ? parseInt(value, 10) : null;
  } catch (error) {
    console.warn("[Widget] Failed to read widget data:", error);
    return null;
  }
}

/**
 * Updates the actions list in shared storage for the iOS widget.
 * Stores a JSON array of action items (contact name + platform).
 * Limited to 5 items to stay within UserDefaults size limits.
 */
export function updateWidgetActionsList(actions: WidgetAction[]): void {
  if (Platform.OS !== "ios" || !storage) {
    return;
  }

  try {
    // Limit to 5 actions to keep data size small
    const limitedActions = actions.slice(0, 5);
    storage.set(ACTIONS_LIST_KEY, JSON.stringify(limitedActions));
    // Trigger widget timeline reload
    ExtensionStorage.reloadWidget("ActionsListWidget");
  } catch (error) {
    console.warn("[Widget] Failed to update actions list:", error);
  }
}
