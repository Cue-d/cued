import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { ActionExecutor } from "./execution.js";
import type { ActionDefinition } from "./registry.js";

const require = createRequire(import.meta.url);

function resolveSkillModulePath(definition: ActionDefinition): string {
  if (definition.module.startsWith("/") || definition.module.includes("..")) {
    throw new Error(`Invalid action executor module path: ${definition.module}`);
  }
  const modulePath = resolve(definition.skillRoot, definition.module);
  const skillRoot = resolve(definition.skillRoot);
  if (!modulePath.startsWith(`${skillRoot}/`)) {
    throw new Error(`Action executor module escapes skill root: ${definition.module}`);
  }
  return modulePath;
}

function loadActionModule(definition: ActionDefinition): Record<string, unknown> {
  const modulePath = resolveSkillModulePath(definition);
  delete require.cache[require.resolve(modulePath)];
  const loaded = require(modulePath) as unknown;
  if (!loaded || typeof loaded !== "object") {
    throw new Error(`Action executor module did not export an object: ${definition.module}`);
  }
  return loaded as Record<string, unknown>;
}

export function loadActionExecutor(definition: ActionDefinition): ActionExecutor | null {
  const execute = loadActionModule(definition).execute;
  return typeof execute === "function" ? (execute as ActionExecutor) : null;
}
