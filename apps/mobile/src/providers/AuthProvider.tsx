import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import {
  type OAuthProvider,
  type WorkOSUser,
  signIn as authSignIn,
  signOut as authSignOut,
  getAccessToken,
  getUser,
  isAuthenticated as checkIsAuthenticated,
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
    checkIsAuthenticated()
      .then(async (authenticated) => {
        if (authenticated) {
          const storedUser = await getUser();
          setUser(storedUser);
        }
      })
      .catch((error) => console.error("Error checking auth state:", error))
      .finally(() => setIsLoading(false));
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
