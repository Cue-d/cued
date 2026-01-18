import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import {
  type OAuthProvider,
  type WorkOSUser,
  signIn as authSignIn,
  signOut as authSignOut,
  getAccessToken,
  getUser,
  getRefreshToken,
  refreshAccessToken,
} from "@/lib/auth";

interface AuthContextType {
  user: WorkOSUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: (provider: OAuthProvider) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [user, setUser] = useState<WorkOSUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function restoreAuthState() {
      try {
        // First check if we have tokens stored
        const [accessToken, refreshToken, storedUser] = await Promise.all([
          getAccessToken(),
          getRefreshToken(),
          getUser(),
        ]);

        if (!accessToken && !refreshToken) {
          // No tokens at all, user needs to sign in
          return;
        }

        if (accessToken && storedUser) {
          // We have both token and user, try to use them
          // Proactively refresh the token to ensure it's valid
          const refreshResult = await refreshAccessToken();
          if (refreshResult) {
            setUser(refreshResult.user);
          } else if (storedUser) {
            // Refresh failed but we have stored user, might still work
            // The token might still be valid
            setUser(storedUser);
          }
        } else if (refreshToken) {
          // We have a refresh token but no access token or user
          // Try to refresh
          const refreshResult = await refreshAccessToken();
          if (refreshResult) {
            setUser(refreshResult.user);
          }
        }
      } catch (error) {
        console.error("Error restoring auth state:", error);
      } finally {
        setIsLoading(false);
      }
    }

    restoreAuthState();
  }, []);

  const signIn = useCallback(async (provider: OAuthProvider) => {
    setIsLoading(true);
    try {
      const result = await authSignIn(provider);
      setUser(result.user);
    } catch (error) {
      console.error("Sign in error:", error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setIsLoading(true);
    try {
      await authSignOut();
      setUser(null);
    } catch (error) {
      console.error("Sign out error:", error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      isAuthenticated: user !== null,
      isLoading,
      signIn,
      signOut,
    }),
    [user, isLoading, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export function useAuthForConvex(): {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: () => Promise<string | null>;
} {
  const { isAuthenticated, isLoading } = useAuth();

  const fetchAccessToken = useCallback(async (): Promise<string | null> => {
    if (!isAuthenticated) return null;
    return getAccessToken();
  }, [isAuthenticated]);

  return useMemo(
    () => ({ isLoading, isAuthenticated, fetchAccessToken }),
    [isLoading, isAuthenticated, fetchAccessToken]
  );
}
