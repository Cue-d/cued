/**
 * Platform configuration constants.
 *
 * Defines colors, labels, and identifiers for supported messaging platforms.
 * Icons are NOT included since web uses lucide-react and mobile uses expo-symbols.
 *
 * @example
 * ```ts
 * import { PLATFORM_CONFIG, type ActionPlatform } from "@prm/shared";
 *
 * const platform: ActionPlatform = "imessage";
 * const { label, color, bgClass, textClass } = PLATFORM_CONFIG[platform];
 * ```
 */

/**
 * Supported messaging platforms for actions.
 */
export type ActionPlatform = "imessage" | "gmail" | "slack";

/**
 * Platform configuration object.
 */
export interface PlatformConfigItem {
  /** Human-readable platform name */
  label: string;
  /** Hex color for the platform (useful for mobile tintColor) */
  color: string;
  /** Tailwind text color class */
  textClass: string;
  /** Tailwind background color class (solid, for badges) */
  bgClass: string;
  /** Single letter abbreviation for compact badges */
  letter: string;
}

/**
 * Platform configuration for iMessage, Gmail, and Slack.
 *
 * @example
 * ```tsx
 * // Web: Use textClass for icons
 * <Mail className={PLATFORM_CONFIG.gmail.textClass} />
 *
 * // Mobile: Use color for tintColor
 * <SymbolView tintColor={PLATFORM_CONFIG.gmail.color} />
 *
 * // Badge: Use bgClass + letter
 * <span className={PLATFORM_CONFIG.gmail.bgClass}>{PLATFORM_CONFIG.gmail.letter}</span>
 * ```
 */
export const PLATFORM_CONFIG: Record<ActionPlatform, PlatformConfigItem> = {
  imessage: {
    label: "iMessage",
    color: "#16a34a",
    textClass: "text-green-600",
    bgClass: "bg-green-500 text-white",
    letter: "i",
  },
  gmail: {
    label: "Gmail",
    color: "#dc2626",
    textClass: "text-red-600",
    bgClass: "bg-red-500 text-white",
    letter: "G",
  },
  slack: {
    label: "Slack",
    color: "#9333ea",
    textClass: "text-purple-600",
    bgClass: "bg-purple-500 text-white",
    letter: "S",
  },
};

/**
 * Get platform config by platform key.
 * Returns undefined if platform is not recognized.
 */
export function getPlatformConfig(
  platform: string
): PlatformConfigItem | undefined {
  return PLATFORM_CONFIG[platform as ActionPlatform];
}
