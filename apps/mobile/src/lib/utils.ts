import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { WorkOSUser } from "@/lib/auth";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
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
