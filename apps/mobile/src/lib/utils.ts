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
    mutedForeground: "#71717A", // zinc-500
    foreground: "#18181B", // zinc-900
    primary: "#EA580C", // orange-600
    destructive: "#DC2626", // red-600
    success: "#16A34A", // green-600
    warning: "#D97706", // amber-600
    info: "#2563EB", // blue-600
    white: "#FFFFFF",
    black: "#000000",
  },
  dark: {
    mutedForeground: "#A1A1AA", // zinc-400
    foreground: "#FAFAFA", // zinc-50
    primary: "#F97316", // orange-500
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

export function getDisplayName(user: WorkOSUser | null): string {
  if (!user) return "User";
  if (user.first_name && user.last_name) {
    return `${user.first_name} ${user.last_name}`;
  }
  return user.email?.split("@")[0] || "User";
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
