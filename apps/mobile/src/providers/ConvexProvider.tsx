import React, { ReactNode, useCallback, useMemo } from "react";
import { ConvexProviderWithAuth } from "convex/react";
import { convex } from "@/lib/convex";

/**
 * Placeholder auth hook for Convex integration.
 * Will be replaced with real auth implementation in Phase 10 (tasks 10.1-10.8)
 * when WorkOS OAuth and SecureStore token management are added.
 *
 * For now, returns unauthenticated state which allows Convex queries
 * that don't require auth to work during development.
 */
function useAuthPlaceholder() {
  // TODO (Phase 10): Replace with real auth from SecureStore
  // - Read access token from expo-secure-store
  // - Validate token with WorkOS userinfo endpoint
  // - Handle token refresh
  const isLoading = false;
  const isAuthenticated = false;

  const fetchAccessToken = useCallback(async (): Promise<string | null> => {
    // TODO (Phase 10): Return token from SecureStore
    return null;
  }, []);

  return useMemo(
    () => ({ isLoading, isAuthenticated, fetchAccessToken }),
    [isLoading, isAuthenticated, fetchAccessToken],
  );
}

interface ConvexProviderProps {
  children: ReactNode;
}

export function ConvexProvider({ children }: ConvexProviderProps): React.JSX.Element {
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useAuthPlaceholder}>
      {children}
    </ConvexProviderWithAuth>
  );
}
