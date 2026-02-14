import type { ActionPlatform } from "@cued/shared";

// Platforms with active sync adapters on web debug tools.
export type ResettablePlatform = Extract<
  ActionPlatform,
  "imessage" | "slack" | "linkedin"
>;
