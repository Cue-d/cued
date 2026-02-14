import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import { api } from "@cued/convex";

const POLL_INTERVAL_MS = 15_000;

interface ElectronPresenceContextValue {
  isOnline: boolean;
  lastSeen: number | null;
  isLoading: boolean;
}

const ElectronPresenceContext = createContext<ElectronPresenceContextValue | null>(null);

export function ElectronPresenceProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const [pollTick, setPollTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setPollTick((tick) => tick + 1);
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  const status = useQuery(api.presence.getElectronStatus, { pollTick });

  const value = useMemo(
    () => ({
      isOnline: status?.isOnline ?? false,
      lastSeen: status?.lastSeen ?? null,
      isLoading: status === undefined,
    }),
    [status]
  );

  return (
    <ElectronPresenceContext.Provider value={value}>
      {children}
    </ElectronPresenceContext.Provider>
  );
}

export function useElectronPrescence(): ElectronPresenceContextValue {
  const context = useContext(ElectronPresenceContext);
  if (!context) {
    throw new Error(
      "useElectronPrescence must be used within an ElectronPresenceProvider"
    );
  }
  return context;
}
