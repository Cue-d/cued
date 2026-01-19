"use client";

import { ReactNode, useCallback } from "react";
import {
  AuthKitProvider,
  useAuth,
  useAccessToken,
} from "@workos-inc/authkit-nextjs/components";
import { ConvexReactClient, ConvexProviderWithAuth } from "convex/react";
import { getConvexUrl } from "@prm/env/client";

const convex = new ConvexReactClient(getConvexUrl());

function useAuthFromAuthKit() {
  const { user, loading: userLoading } = useAuth();
  const { accessToken, loading: tokenLoading } = useAccessToken();

  const isLoading = userLoading || tokenLoading;
  const isAuthenticated = !isLoading && !!user && !!accessToken;

  const fetchAccessToken = useCallback(
    async () => accessToken ?? null,
    [accessToken]
  );

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
