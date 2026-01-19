"use client"

import { Mail, MessageCircle } from "lucide-react"
export { formatRelativeTime } from "@prm/shared"

export function PlatformIcon({ platform }: { platform: string }) {
  if (platform === "gmail") {
    return <Mail className="size-3" />
  }
  return <MessageCircle className="size-3" />
}

export function formatActionType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}
