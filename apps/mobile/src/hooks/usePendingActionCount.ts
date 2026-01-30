import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@cued/convex/convex/_generated/api";
import { updateWidgetData } from "@/lib/widget-data";

/**
 * Hook to get pending action count for badge display.
 * Uses denormalized counter on users table for efficiency.
 * Also updates iOS widget with the current count.
 */
export function usePendingActionCount(): number {
  const result = useQuery(api.actions.getPendingActionCount);
  const count = result?.count ?? 0;

  // Update iOS widget when action count changes
  useEffect(() => {
    updateWidgetData(count);
  }, [count]);

  return count;
}
