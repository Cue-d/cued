import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@cued/convex/convex/_generated/api";
import { registerForPushNotifications } from "@/lib/notifications";
import { useAuth } from "@/providers/AuthProvider";

/**
 * Component that registers push token with Convex after authentication.
 * Should be rendered inside both ConvexProvider and AuthProvider.
 * Silently handles token registration - no UI.
 */
export function PushTokenRegistrar(): null {
  const { isAuthenticated } = useAuth();
  const registerPushToken = useMutation(api.users.registerPushToken);
  const hasRegistered = useRef(false);

  useEffect(() => {
    // Only attempt registration once per mount when authenticated
    if (!isAuthenticated || hasRegistered.current) {
      return;
    }

    async function registerToken() {
      try {
        const token = await registerForPushNotifications();
        if (token) {
          await registerPushToken({ pushToken: token });
          hasRegistered.current = true;
          console.log("Push token registered successfully");
        }
      } catch (error) {
        // Silently fail - push tokens are optional
        console.warn("Failed to register push token:", error);
      }
    }

    registerToken();
  }, [isAuthenticated, registerPushToken]);

  // This component renders nothing
  return null;
}
