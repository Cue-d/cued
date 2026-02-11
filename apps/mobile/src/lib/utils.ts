import { Linking } from "react-native";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { WorkOSUser } from "@/lib/auth";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Theme colors for use with third-party components like SymbolView
 * that don't support className props.
 */
export const themeColors = {
  light: {
    background: "#FFFFFF", // white
    secondaryBackground: "#F5F5F4", // stone-100 (for grouped settings)
    mutedForeground: "#71717A", // zinc-500
    foreground: "#18181B", // zinc-900
    primary: "#3D3D3D", // oklch(30.52% 0 0) - design system primary
    destructive: "#DC2626", // red-600
    success: "#16A34A", // green-600
    warning: "#D97706", // amber-600
    info: "#2563EB", // blue-600
    white: "#FFFFFF",
    black: "#000000",
  },
  dark: {
    background: "#161616", // oklch(20% 0 0) - matches CSS --color-background
    secondaryBackground: "#0C0A09", // stone-950 (darker than cards for contrast)
    mutedForeground: "#A1A1AA", // zinc-400
    foreground: "#FAFAFA", // zinc-50
    primary: "#FAFAF9", // oklch(98.8% 0.0041 91.45) - design system primary
    destructive: "#EF4444", // red-500
    success: "#22C55E", // green-500
    warning: "#F59E0B", // amber-500
    info: "#3B82F6", // blue-500
    white: "#FFFFFF",
    black: "#000000",
  },
} as const;

/** Get theme colors based on color scheme */
export function getThemeColors(isDark: boolean) {
  return isDark ? themeColors.dark : themeColors.light;
}

/** Returns true if the display name looks like an actual person name (not a phone/ID/email) */
export function isRealContactName(displayName: string): boolean {
  const trimmed = displayName.trim();
  if (!trimmed) return false;
  if (/^[\d+\-(). ]+$/.test(trimmed)) return false;
  if (/^[UW][A-Z0-9]{8,}$/i.test(trimmed)) return false;
  if (trimmed.startsWith("urn:li:")) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false;
  return true;
}

export function getDisplayName(user: WorkOSUser | null): string {
  if (!user) return "User";
  if (user.first_name && user.last_name) {
    return `${user.first_name} ${user.last_name}`;
  }
  return user.email?.split("@")[0] || "User";
}

// ── Deep linking ─────────────────────────────────────────────────
// Re-export shared deep link utilities for convenience
export {
  getPlatformDeeplink,
  getContactDeeplink,
  getOpenInAppLabel,
} from "@cued/shared";

/** Open a URL in the platform's native app via React Native Linking. */
export async function openDeeplink(url: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch (error) {
    console.warn("Failed to open deep link:", url, error);
  }
}
