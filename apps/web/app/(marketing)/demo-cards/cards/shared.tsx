import { PlatformIcon as PlatformIconBase } from "@cued/ui";
import type { DemoPlatform } from "../demo-card-data";

// Actual brand colors
const BRAND_COLORS: Record<DemoPlatform, { fg: string; bg: string }> = {
  imessage: { fg: "#30D158", bg: "rgba(48,209,88,0.12)" },
  gmail: { fg: "#EA4335", bg: "rgba(234,67,53,0.12)" },
  slack: { fg: "#611F69", bg: "rgba(97,31,105,0.12)" },
  linkedin: { fg: "#0A66C2", bg: "rgba(10,102,194,0.12)" },
};

/** Small icon with a tinted background circle — use in card headers */
export function PlatformBadge({
  platform,
}: {
  platform: DemoPlatform;
}) {
  const { fg, bg } = BRAND_COLORS[platform];

  return (
    <span
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full"
      style={{ backgroundColor: bg, color: fg }}
    >
      <PlatformIconBase platform={platform} className="size-3.5" />
    </span>
  );
}
