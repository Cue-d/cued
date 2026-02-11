import { anyApi } from "convex/server";

// Keep runtime stable in CI/mobile preview even when generated JS files are absent.
// Typing still comes from the generated declaration file when present.
export const api = anyApi as unknown as typeof import("./convex/_generated/api.js").api;
export type { Id, Doc } from "./convex/_generated/dataModel.js";
