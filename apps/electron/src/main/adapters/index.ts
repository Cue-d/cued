/**
 * Adapter registry for the unified message queue.
 * Routes messages to platform-specific adapters (iMessage, LinkedIn, etc.)
 */
import type { ActionPlatform, PlatformAdapter } from "@cued/shared";

import { IMessageAdapter } from "../platforms/imessage/adapter";
import { LinkedInAdapter } from "../platforms/linkedin/adapter";
import { SignalAdapter } from "../platforms/signal/adapter";
import { SlackAdapter } from "../platforms/slack/adapter";
import { TwitterAdapter } from "../platforms/twitter/adapter";

/**
 * Singleton adapter instances.
 * Created lazily on first getAdapter() call.
 */
const adapterInstances: Partial<Record<ActionPlatform, PlatformAdapter>> = {};

/**
 * Map of platform to adapter class constructor.
 * Add new adapters here as they are implemented.
 */
const adapterRegistry: Partial<
  Record<ActionPlatform, new () => PlatformAdapter>
> = {
  imessage: IMessageAdapter,
  linkedin: LinkedInAdapter,
  signal: SignalAdapter,
  slack: SlackAdapter,
  twitter: TwitterAdapter,
};

/**
 * Platforms that use server-side sending instead of Electron adapters.
 * These are handled by the Convex action directly, not the message queue processor.
 */
export const SERVER_SIDE_PLATFORMS: ActionPlatform[] = [];

/**
 * Get the adapter for a given platform.
 * Returns undefined for platforms without adapters.
 *
 * @param platform - The platform to get an adapter for
 * @returns The adapter instance, or undefined if not supported
 *
 * @example
 * ```ts
 * const adapter = getAdapter("imessage");
 * if (adapter) {
 *   const result = await adapter.send(message);
 * }
 * ```
 */
export function getAdapter(platform: ActionPlatform): PlatformAdapter | undefined {
  // Check if this platform uses server-side sending
  if (SERVER_SIDE_PLATFORMS.includes(platform)) {
    return undefined;
  }

  // Return existing instance if available
  if (adapterInstances[platform]) {
    return adapterInstances[platform];
  }

  // Create new instance if adapter exists
  const AdapterClass = adapterRegistry[platform];
  if (AdapterClass) {
    adapterInstances[platform] = new AdapterClass();
    return adapterInstances[platform];
  }

  // No adapter for this platform
  return undefined;
}

/**
 * Check if a platform has an Electron adapter.
 *
 * @param platform - The platform to check
 * @returns true if an adapter exists
 */
export function hasAdapter(platform: ActionPlatform): boolean {
  return platform in adapterRegistry;
}

/**
 * Get all platforms with Electron adapters.
 *
 * @returns Array of supported platform names
 */
export function getSupportedPlatforms(): ActionPlatform[] {
  return Object.keys(adapterRegistry) as ActionPlatform[];
}

// Re-export adapter classes for testing
export { IMessageAdapter } from "../platforms/imessage/adapter";
export { LinkedInAdapter } from "../platforms/linkedin/adapter";
export { SignalAdapter } from "../platforms/signal/adapter";
export { SlackAdapter } from "../platforms/slack/adapter";
export { TwitterAdapter } from "../platforms/twitter/adapter";
