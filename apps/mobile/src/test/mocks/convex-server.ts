/**
 * Mock convex/server for testing
 * Provides minimal exports to satisfy imports from generated api.js
 */

// anyApi returns a proxy that creates string references for any path
export const anyApi = new Proxy({} as Record<string, unknown>, {
  get(_target, module: string) {
    return new Proxy({} as Record<string, string>, {
      get(_target2, fn: string) {
        return `${module}:${fn}`;
      },
    });
  },
});

// componentsGeneric returns empty object
export function componentsGeneric() {
  return {};
}
