"use client";

import { ReactNode, useCallback, useEffect } from "react";
import {
  AuthKitProvider,
  useAuth,
  useAccessToken,
} from "@workos-inc/authkit-nextjs/components";
import { ConvexReactClient, ConvexProviderWithAuth } from "convex/react";
import { getConvexUrl } from "@cued/env/client";

const convex = new ConvexReactClient(getConvexUrl());

function decodeTokenExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

function useAuthFromAuthKit() {
  const { user, loading: userLoading } = useAuth();
  const {
    accessToken,
    loading: tokenLoading,
    getAccessToken,
  } = useAccessToken();

  const isLoading = userLoading || tokenLoading;
  const isAuthenticated = !isLoading && !!user && !!accessToken;

  // Warn in dev when the current token is already expired
  useEffect(() => {
    if (process.env.NODE_ENV === "development" && accessToken) {
      const exp = decodeTokenExp(accessToken);
      if (exp && exp - Math.floor(Date.now() / 1000) <= 0) {
        console.warn("[ConvexAuth] access token is expired");
      }
    }
  }, [accessToken]);

  const fetchAccessToken = useCallback(async () => {
    const token = await getAccessToken();
    return token ?? null;
  }, [getAccessToken]);

  return { isLoading, isAuthenticated, fetchAccessToken };
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <AuthKitProvider>
      <ConvexProviderWithAuth client={convex} useAuth={useAuthFromAuthKit}>
        {children}
      </ConvexProviderWithAuth>
    </AuthKitProvider>
  );
}
