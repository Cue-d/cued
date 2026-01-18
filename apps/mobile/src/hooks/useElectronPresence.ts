import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@prm/convex/convex/_generated/api";

// Poll every 15 seconds to check desktop status
const POLL_INTERVAL_MS = 15_000;

/**
 * Hook to get the electron desktop app's online status.
 * Polls every 15 seconds to check if desktop sent a heartbeat recently.
 * Returns isOnline=true if heartbeat received within last 30 seconds.
 */
export function useElectronPresence() {
  // Use a timestamp to force query re-evaluation on each poll
  const [pollTick, setPollTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setPollTick((t) => t + 1);
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  // Pass pollTick to force Convex to re-run the query
  const status = useQuery(api.presence.getElectronStatus, { pollTick });

  return {
    isOnline: status?.isOnline ?? false,
    lastSeen: status?.lastSeen ?? null,
    isLoading: status === undefined,
  };
}
