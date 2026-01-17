import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  ReactNode,
} from "react";
import {
  WorkOSUser,
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
  signIn: (provider: "GoogleOAuth" | "AppleOAuth") => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<WorkOSUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Check for existing authentication on mount
  useEffect(() => {
    async function checkAuth() {
      try {
        const authenticated = await checkIsAuthenticated();
        if (authenticated) {
          const storedUser = await getUser();
          setUser(storedUser);
        }
      } catch (error) {
        console.error("Error checking auth state:", error);
      } finally {
        setIsLoading(false);
      }
    }

    checkAuth();
  }, []);

  const signIn = useCallback(
    async (provider: "GoogleOAuth" | "AppleOAuth") => {
      try {
        setIsLoading(true);
        const result = await authSignIn(provider);
        setUser(result.user);
      } catch (error) {
        console.error("Sign in error:", error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  const signOut = useCallback(async () => {
    try {
      setIsLoading(true);
      await authSignOut();
      setUser(null);
    } catch (error) {
      console.error("Sign out error:", error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const isAuthenticated = user !== null;

  const value = useMemo(
    () => ({
      user,
      isAuthenticated,
      isLoading,
      signIn,
      signOut,
    }),
    [user, isAuthenticated, isLoading, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access auth context
 */
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

/**
 * Hook for Convex authentication integration
 * Returns the format expected by ConvexProviderWithAuth
 */
export function useAuthForConvex() {
  const { isAuthenticated, isLoading } = useAuth();

  const fetchAccessToken = useCallback(async (): Promise<string | null> => {
    if (!isAuthenticated) return null;
    return getAccessToken();
  }, [isAuthenticated]);

  return useMemo(
    () => ({
      isLoading,
      isAuthenticated,
      fetchAccessToken,
    }),
    [isLoading, isAuthenticated, fetchAccessToken]
  );
}
