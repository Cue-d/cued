import { cn } from "../lib/utils"
import type { ActionPlatform } from "@cued/shared"

interface IconProps {
  className?: string
}

/** Apple iMessage / Messages bubble */
export function IMessageIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4", className)}
    >
      <path d="M12 2C6.477 2 2 5.813 2 10.5c0 2.086.812 4.003 2.188 5.542-.254 1.467-.89 2.97-1.72 4.114a.454.454 0 0 0 .378.746c2.242-.316 3.784-1.159 4.588-1.737A12.2 12.2 0 0 0 12 19.9c5.523 0 10-4.213 10-9.4S17.523 2 12 2Z" />
    </svg>
  )
}

/** Gmail envelope / M-shape (monochrome, inherits currentColor) */
export function GmailIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4", className)}
    >
      <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2Zm0 4-8 5-8-5V6l8 5 8-5v2Z" />
    </svg>
  )
}

/** Gmail official multi-color logo */
export function GmailColorIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 122.88 92.12"
      className={cn("size-4", className)}
    >
      <path fill="#4285F4" d="M8.36,92.12h19.54V44.67L0,23.76v60.08C0,88.42,3.78,92.12,8.36,92.12z" />
      <path fill="#34A853" d="M94.97,92.12h19.54c4.67,0,8.36-3.78,8.36-8.36v-60L94.97,44.67V92.12z" />
      <path fill="#FBBC04" d="M94.97,8.4v36.27l27.91-20.91V12.58c0-10.37-11.82-16.25-20.11-10.05L94.97,8.4z" />
      <polygon fill="#EA4335" points="27.9,44.67 27.9,8.4 61.44,33.57 94.97,8.4 94.97,44.67 61.44,69.76" />
      <path fill="#C5221F" d="M0,12.58v11.18l27.91,20.91V8.4l-7.8-5.87C11.82-3.66,0,2.29,0,12.58z" />
    </svg>
  )
}

/** Slack hashtag logo */
export function SlackIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn("size-4", className)}
    >
      <path d="M3.362 10.11c0 .926-.756 1.681-1.681 1.681S0 11.036 0 10.111.756 8.43 1.68 8.43h1.682zm.846 0c0-.924.756-1.68 1.681-1.68s1.681.756 1.681 1.68v4.21c0 .924-.756 1.68-1.68 1.68a1.685 1.685 0 0 1-1.682-1.68zM5.89 3.362c-.926 0-1.682-.756-1.682-1.681S4.964 0 5.89 0s1.68.756 1.68 1.68v1.682zm0 .846c.924 0 1.68.756 1.68 1.681S6.814 7.57 5.89 7.57H1.68C.757 7.57 0 6.814 0 5.89c0-.926.756-1.682 1.68-1.682zm6.749 1.682c0-.926.755-1.682 1.68-1.682S16 4.964 16 5.889s-.756 1.681-1.68 1.681h-1.681zm-.848 0c0 .924-.755 1.68-1.68 1.68A1.685 1.685 0 0 1 8.43 5.89V1.68C8.43.757 9.186 0 10.11 0c.926 0 1.681.756 1.681 1.68zm-1.681 6.748c.926 0 1.682.756 1.682 1.681S11.036 16 10.11 16s-1.681-.756-1.681-1.68v-1.682h1.68zm0-.847c-.924 0-1.68-.755-1.68-1.68s.756-1.681 1.68-1.681h4.21c.924 0 1.68.756 1.68 1.68 0 .926-.756 1.681-1.68 1.681z" />
    </svg>
  )
}

/** LinkedIn "in" logo */
export function LinkedInIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn("size-4", className)}
    >
      <path d="M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 0 16 .513 16 1.146v13.708c0 .633-.526 1.146-1.175 1.146H1.175C.526 16 0 15.487 0 14.854zm4.943 12.248V6.169H2.542v7.225zm-1.2-8.212c.837 0 1.358-.554 1.358-1.248-.015-.709-.52-1.248-1.342-1.248S2.4 3.226 2.4 3.934c0 .694.521 1.248 1.327 1.248zm4.908 8.212V9.359c0-.216.016-.432.08-.586.173-.431.568-.878 1.232-.878.869 0 1.216.662 1.216 1.634v3.865h2.401V9.25c0-2.22-1.184-3.252-2.764-3.252-1.274 0-1.845.7-2.165 1.193v.025h-.016l.016-.025V6.169h-2.4c.03.678 0 7.225 0 7.225z" />
    </svg>
  )
}

/** Twitter / X logo */
export function TwitterIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4", className)}
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

/** Signal messenger bubble */
export function SignalIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4", className)}
    >
      <path d="M12 2a9.89 9.89 0 0 0-7.071 2.929A9.89 9.89 0 0 0 2 12a9.82 9.82 0 0 0 1.347 5.008L2 22l4.992-1.347A9.82 9.82 0 0 0 12 22a9.89 9.89 0 0 0 7.071-2.929A9.89 9.89 0 0 0 22 12a9.89 9.89 0 0 0-2.929-7.071A9.89 9.89 0 0 0 12 2Zm-.5 5a.75.75 0 0 1 .75.75v.5a3.25 3.25 0 0 1 3 3.25.75.75 0 0 1-1.5 0 1.75 1.75 0 0 0-1.5-1.732v.482a.75.75 0 0 1-1.5 0V7.75A.75.75 0 0 1 11.5 7Zm.25 6.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z" />
    </svg>
  )
}

/** WhatsApp phone-in-bubble */
export function WhatsAppIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn("size-4", className)}
    >
      <path d="M13.601 2.326A7.85 7.85 0 0 0 7.994 0C3.627 0 .068 3.558.064 7.926c0 1.399.366 2.76 1.057 3.965L0 16l4.204-1.102a7.9 7.9 0 0 0 3.79.965h.004c4.368 0 7.926-3.558 7.93-7.93A7.9 7.9 0 0 0 13.6 2.326zM7.994 14.521a6.6 6.6 0 0 1-3.356-.92l-.24-.144-2.494.654.666-2.433-.156-.251a6.56 6.56 0 0 1-1.007-3.505c0-3.626 2.957-6.584 6.591-6.584a6.56 6.56 0 0 1 4.66 1.931 6.56 6.56 0 0 1 1.928 4.66c-.004 3.639-2.961 6.592-6.592 6.592m3.615-4.934c-.197-.099-1.17-.578-1.353-.646-.182-.065-.315-.099-.445.099-.133.197-.513.646-.627.775-.114.133-.232.148-.43.05-.197-.1-.836-.308-1.592-.985-.59-.525-.985-1.175-1.103-1.372-.114-.198-.011-.304.088-.403.087-.088.197-.232.296-.346.1-.114.133-.198.198-.33.065-.134.034-.248-.015-.347-.05-.099-.445-1.076-.612-1.47-.16-.389-.323-.335-.445-.34-.114-.007-.247-.007-.38-.007a.73.73 0 0 0-.529.247c-.182.198-.691.677-.691 1.654s.71 1.916.81 2.049c.098.133 1.394 2.132 3.383 2.992.47.205.84.326 1.129.418.475.152.904.129 1.246.08.38-.058 1.171-.48 1.338-.943.164-.464.164-.86.114-.943-.049-.084-.182-.133-.38-.232" />
    </svg>
  )
}

/** Map of platform to icon component */
const PLATFORM_ICON_MAP: Record<ActionPlatform, React.ComponentType<IconProps>> = {
  imessage: IMessageIcon,
  gmail: GmailIcon,
  slack: SlackIcon,
  linkedin: LinkedInIcon,
  twitter: TwitterIcon,
  signal: SignalIcon,
  whatsapp: WhatsAppIcon,
}

export interface PlatformIconProps {
  platform: ActionPlatform | string
  className?: string
}

/**
 * Shared PlatformIcon component - renders the correct brand SVG for a given platform.
 * Uses `currentColor` fill so it inherits color from parent via Tailwind text classes.
 */
export function PlatformIcon({ platform, className }: PlatformIconProps) {
  const Icon = PLATFORM_ICON_MAP[platform as ActionPlatform]
  if (!Icon) return null
  return <Icon className={className} />
}

/**
 * Pre-built record mapping each platform to its icon component.
 * Useful when you need the component type rather than a rendered element.
 */
export const PLATFORM_ICON_COMPONENTS = PLATFORM_ICON_MAP
