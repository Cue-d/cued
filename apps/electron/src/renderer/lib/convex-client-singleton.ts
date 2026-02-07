import { ConvexReactClient } from "convex/react"

interface ConvexClientEntry {
  client: ConvexReactClient
  url: string
}

let clientEntry: ConvexClientEntry | null = null

/**
 * Returns a renderer-lifetime Convex client.
 * Reuses the existing instance for the same URL.
 */
export function getOrCreateConvexClient(url: string): ConvexReactClient {
  if (clientEntry?.url === url) {
    return clientEntry.client
  }

  if (clientEntry) {
    clientEntry.client.close()
  }

  clientEntry = {
    client: new ConvexReactClient(url),
    url,
  }

  return clientEntry.client
}

/**
 * Closes and clears the singleton Convex client.
 */
export function closeConvexClientSingleton(): void {
  if (!clientEntry) return
  clientEntry.client.close()
  clientEntry = null
}

/**
 * Test-only reset hook.
 */
export function __resetConvexClientSingletonForTests(): void {
  clientEntry = null
}
