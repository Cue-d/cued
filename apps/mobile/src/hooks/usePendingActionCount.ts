import { useQuery } from "convex/react";
import { api } from "@prm/convex/convex/_generated/api";

/**
 * Hook to get pending action count for badge display.
 * Uses denormalized counter on users table for efficiency.
 */
export function usePendingActionCount(): number {
  const result = useQuery(api.actions.getPendingActionCount);
  return result?.count ?? 0;
}
