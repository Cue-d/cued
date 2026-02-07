import type { DemoPlatform } from "../demo-card-data";
export { PlatformIcon } from "@cued/ui";

export function platformColor(platform: DemoPlatform): string {
  switch (platform) {
    case "imessage":
      return "text-green-500";
    case "gmail":
      return "text-red-500";
    case "slack":
      return "text-purple-500";
    case "linkedin":
      return "text-blue-500";
  }
}
