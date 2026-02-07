/**
 * ActionQueueContext - Shared state for the action queue UI.
 *
 * Lifts state out of the actions screen so that the NativeTabs.BottomAccessory
 * (which renders two copies) and the action list sheet can share a single
 * source of truth for actions, queued messages, filters, and sheet state.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useMutation } from "convex/react";
import { api } from "@cued/convex/convex/_generated/api";
import { type ActionPlatform, type EnrichedAction, isMessageActionType, isContactActionType } from "@cued/shared";
import { useActions } from "@/hooks/useActions";
import type { Id } from "@cued/convex/convex/_generated/dataModel";

/** Data for a queued message toast */
export interface QueuedMessageToast {
  messageId: string;
  platform: ActionPlatform;
  recipientName: string;
  messagePreview?: string;
  /** Timestamp (ms) when the message will be sent (for countdown display) */
  scheduledFor: number;
}

/** Action type filter options (grouped) */
export type ActionTypeFilter = "all" | "messages" | "contacts";

/** Platform filter options */
export type PlatformFilter = "all" | ActionPlatform;

interface ActionQueueContextValue {
  /** All pending actions from Convex */
  actions: EnrichedAction[];
  /** Whether actions are still loading */
  isLoading: boolean;
  /** Actions filtered by current filters */
  filteredActions: EnrichedAction[];
  /** The top action (first in the list) */
  topAction: EnrichedAction | undefined;

  /** Queued messages waiting to be sent (with undo capability) */
  queuedMessages: QueuedMessageToast[];
  /** Add a queued message to the list */
  addQueuedMessage: (msg: QueuedMessageToast) => void;
  /** Cancel a queued message */
  handleUndoMessage: (messageId: string) => Promise<void>;
  /** Dismiss a toast (remove from local state) */
  handleToastDismiss: (messageId: string, reason: "sent" | "cancelled" | "closed") => void;

  /** Whether the action list bottom sheet is open */
  isSheetOpen: boolean;
  /** Open or close the action list bottom sheet */
  setIsSheetOpen: (open: boolean) => void;

  /** Current platform filter */
  platformFilter: PlatformFilter;
  /** Set platform filter */
  setPlatformFilter: (filter: PlatformFilter) => void;
  /** Current action type filter */
  typeFilter: ActionTypeFilter;
  /** Set action type filter */
  setTypeFilter: (filter: ActionTypeFilter) => void;

  /** ID of the action to bring to focus in the card stack */
  focusedActionId: string | null;
  /** Set the focused action ID (from sheet row tap) */
  setFocusedActionId: (id: string | null) => void;
}

const ActionQueueContext = createContext<ActionQueueContextValue | null>(null);

export function ActionQueueProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { actions: rawActions, isLoading } = useActions({ limit: 20 });
  const cancelMessage = useMutation(api.messageQueue.cancelMessage);

  // Cast actions to our enriched type
  const actions = rawActions as EnrichedAction[];

  // Queued messages for undo toasts
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessageToast[]>([]);

  // Sheet state
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  // Filter state
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [typeFilter, setTypeFilter] = useState<ActionTypeFilter>("all");

  // Focused action (from sheet row tap)
  const [focusedActionId, setFocusedActionId] = useState<string | null>(null);

  // Derived: top action (respects focused action from sheet tap)
  const topAction = focusedActionId
    ? actions.find((a) => a._id === focusedActionId) ?? actions[0]
    : actions[0];

  // Derived: filtered actions
  const filteredActions = useMemo(() => {
    return actions.filter((action) => {
      if (platformFilter !== "all" && action.platform !== platformFilter) return false;
      if (typeFilter === "messages" && !isMessageActionType(action.type)) return false;
      if (typeFilter === "contacts" && !isContactActionType(action.type)) return false;
      return true;
    });
  }, [actions, platformFilter, typeFilter]);

  const addQueuedMessage = useCallback((msg: QueuedMessageToast) => {
    setQueuedMessages((prev) => [...prev, msg]);
  }, []);

  const handleUndoMessage = useCallback(
    async (messageId: string) => {
      await cancelMessage({ messageId: messageId as Id<"messageQueue"> });
    },
    [cancelMessage],
  );

  const handleToastDismiss = useCallback(
    (messageId: string, _reason: "sent" | "cancelled" | "closed") => {
      setQueuedMessages((prev) => prev.filter((m) => m.messageId !== messageId));
    },
    [],
  );

  const value = useMemo<ActionQueueContextValue>(
    () => ({
      actions,
      isLoading,
      filteredActions,
      topAction,
      queuedMessages,
      addQueuedMessage,
      handleUndoMessage,
      handleToastDismiss,
      isSheetOpen,
      setIsSheetOpen,
      platformFilter,
      setPlatformFilter,
      typeFilter,
      setTypeFilter,
      focusedActionId,
      setFocusedActionId,
    }),
    [
      actions,
      isLoading,
      filteredActions,
      topAction,
      queuedMessages,
      addQueuedMessage,
      handleUndoMessage,
      handleToastDismiss,
      isSheetOpen,
      platformFilter,
      typeFilter,
      focusedActionId,
    ],
  );

  return (
    <ActionQueueContext.Provider value={value}>
      {children}
    </ActionQueueContext.Provider>
  );
}

export function useActionQueue(): ActionQueueContextValue {
  const context = useContext(ActionQueueContext);
  if (!context) {
    throw new Error("useActionQueue must be used within an ActionQueueProvider");
  }
  return context;
}
