import { ConvexReactClient } from "convex/react";
import { createMMKV, type MMKV } from "react-native-mmkv";
import { clientEnv } from "@cued/env/client";

// MMKV storage instance for Convex cache
// Uses a dedicated instance ID to isolate from other app storage
// Lazy initialization since createMMKV requires native module
let _convexStorage: MMKV | null = null;

export function getConvexStorage(): MMKV {
  if (!_convexStorage) {
    _convexStorage = createMMKV({ id: "convex-cache" });
  }
  return _convexStorage;
}

// Convex client instance
const convexUrl = clientEnv.EXPO_PUBLIC_CONVEX_URL;

if (!convexUrl) {
  throw new Error(
    "Missing EXPO_PUBLIC_CONVEX_URL environment variable. " +
      "Add it to your .env.local file or EAS secrets.",
  );
}

export const convex = new ConvexReactClient(convexUrl);
