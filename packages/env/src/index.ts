// Re-export schemas for custom validation needs
export * from "./schemas.js"

// Re-export server env (default for Node.js apps)
export { env, validateEnv } from "./server.js"
export type { ServerEnv } from "./server.js"

// Re-export client env
export { clientEnv, getConvexUrl } from "./client.js"
export type { ClientEnv } from "./client.js"

// Re-export Convex helpers
export { convexEnv, requireEnv, getEnv } from "./convex.js"

// Re-export Electron env
export { electronEnv, validateElectronEnv } from "./electron.js"
export type { ElectronEnv } from "./electron.js"
