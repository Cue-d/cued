import React, { ReactNode } from "react";
import { ConvexProviderWithAuth } from "convex/react";
import { convex } from "@/lib/convex";
import { useAuthForConvex } from "./AuthProvider";

interface ConvexProviderProps {
  children: ReactNode;
}

export function ConvexProvider({ children }: ConvexProviderProps): React.JSX.Element {
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useAuthForConvex}>
      {children}
    </ConvexProviderWithAuth>
  );
}
