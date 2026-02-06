export { formatRelativeTime } from "@cued/shared"
export { PlatformIcon } from "../../../components/platform-icons"

export function formatActionType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}
