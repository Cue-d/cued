/**
 * ActionQueueContext - Shared state for the action queue UI.
 *
 * Lifts state out of the actions screen so that the NativeTabs.BottomAccessory
 * (which renders two copies) and the action list sheet can share a single
 * source of truth for actions, filters, and sheet state.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import { api } from "@cued/convex";
import { type ActionPlatform, type EnrichedAction } from "@cued/shared";
import { useActions } from "@/hooks/useActions";

/** Action type filter options (grouped) */
export type ActionTypeFilter = "all" | "respond" | "followups" | "contacts";

/** Platform filter options */
export type PlatformFilter = "all" | ActionPlatform;

/** Sheet tab: queue (pending) or history (completed/discarded) */
export type SheetTab = "queue" | "history";

interface ActionQueueContextValue {
  /** All pending actions from Convex */
  actions: EnrichedAction[];
  /** Whether actions are still loading */
  isLoading: boolean;
  /** Actions filtered by current filters */
  filteredActions: EnrichedAction[];
  /** The top action (first in the list) */
  topAction: EnrichedAction | undefined;

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

  /** Locally cached completed actions (kept visible until dismissed) */
  completedActionCache: Record<string, EnrichedAction>;
  /** Cache an action as completed (keeps it visible after Convex removes it) */
  markActionCompleted: (action: EnrichedAction) => void;
  /** Remove a completed action from the local cache */
  clearCompletedAction: (actionId: string) => void;

  /** Current sheet tab */
  sheetTab: SheetTab;
  /** Switch between queue and history tabs */
  setSheetTab: (tab: SheetTab) => void;
  /** History actions (completed + discarded) */
  historyActions: EnrichedAction[];
  /** Whether history is still loading */
  isHistoryLoading: boolean;
}

const ActionQueueContext = createContext<ActionQueueContextValue | null>(null);

export function ActionQueueProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}): React.JSX.Element {
  const { actions: rawActions, isLoading } = useActions({ enabled, limit: 50 });

  // Cast actions to our enriched type
  const actions = rawActions as EnrichedAction[];

  // Sheet state
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState<SheetTab>("queue");

  // Filter state
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [typeFilter, setTypeFilter] = useState<ActionTypeFilter>("all");

  // History query (only runs when history tab is active)
  const historyResult = useQuery(
    api.actions.getActionHistory,
    sheetTab === "history" ? { limit: 50 } : "skip",
  );
  const historyActions = useMemo(
    () => (historyResult?.actions ?? []) as EnrichedAction[],
    [historyResult?.actions],
  );
  const isHistoryLoading = sheetTab === "history" && historyResult === undefined;

  // Focused action (from sheet row tap)
  const [focusedActionId, setFocusedActionId] = useState<string | null>(null);

  // Locally cached completed actions (kept visible until user dismisses)
  const [completedActionCache, setCompletedActionCache] = useState<Record<string, EnrichedAction>>({});

  // Derived: top action (respects focused action from sheet tap)
  const topAction = focusedActionId
    ? actions.find((a) => a._id === focusedActionId) ?? actions[0]
    : actions[0];

  // Derived: filtered actions
  const filteredActions = useMemo(() => {
    return actions.filter((action) => {
      if (platformFilter !== "all" && action.platform !== platformFilter) return false;
      if (typeFilter === "respond" && action.type !== "respond") return false;
      if (typeFilter === "followups" && action.type !== "follow_up") return false;
      if (typeFilter === "contacts" && action.type !== "resolve_contact") return false;
      return true;
    });
  }, [actions, platformFilter, typeFilter]);

  const markActionCompleted = useCallback((action: EnrichedAction) => {
    setCompletedActionCache((prev) => ({ ...prev, [action._id]: action }));
  }, []);

  const clearCompletedAction = useCallback((actionId: string) => {
    setCompletedActionCache((prev) => {
      const next = { ...prev };
      delete next[actionId];
      return next;
    });
  }, []);

  const value = useMemo<ActionQueueContextValue>(
    () => ({
      actions,
      isLoading,
      filteredActions,
      topAction,
      isSheetOpen,
      setIsSheetOpen,
      platformFilter,
      setPlatformFilter,
      typeFilter,
      setTypeFilter,
      focusedActionId,
      setFocusedActionId,
      completedActionCache,
      markActionCompleted,
      clearCompletedAction,
      sheetTab,
      setSheetTab,
      historyActions,
      isHistoryLoading,
    }),
    [
      actions,
      isLoading,
      filteredActions,
      topAction,
      isSheetOpen,
      platformFilter,
      typeFilter,
      focusedActionId,
      completedActionCache,
      markActionCompleted,
      clearCompletedAction,
      sheetTab,
      historyActions,
      isHistoryLoading,
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
