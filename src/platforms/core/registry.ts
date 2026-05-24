import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_PLATFORM_VALUES,
  type AdapterPlatform,
  isAdapterPlatform,
} from "../../core/types/provider.js";

export { isAdapterPlatform } from "../../core/types/provider.js";

export interface AdapterDefinition {
  platform: AdapterPlatform;
  workerEntrypoint: string;
  workerTimeoutMs: number;
}

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));

const ADAPTER_DEFINITIONS: Record<AdapterPlatform, AdapterDefinition> = {
  imessage: {
    platform: "imessage",
    workerEntrypoint: join(MODULE_DIRNAME, "../imessage/worker.js"),
    workerTimeoutMs: 120_000,
  },
  discord: {
    platform: "discord",
    workerEntrypoint: join(MODULE_DIRNAME, "../discord/sync/worker.js"),
    workerTimeoutMs: 120_000,
  },
  contacts: {
    platform: "contacts",
    workerEntrypoint: join(MODULE_DIRNAME, "../contacts/worker.js"),
    workerTimeoutMs: 120_000,
  },
  gmail: {
    platform: "gmail",
    workerEntrypoint: join(MODULE_DIRNAME, "../gmail/sync/worker.js"),
    workerTimeoutMs: 600_000,
  },
  linkedin: {
    platform: "linkedin",
    workerEntrypoint: join(MODULE_DIRNAME, "../linkedin/sync/worker.js"),
    workerTimeoutMs: 120_000,
  },
  slack: {
    platform: "slack",
    workerEntrypoint: join(MODULE_DIRNAME, "../slack/sync/worker.js"),
    workerTimeoutMs: 600_000,
  },
  signal: {
    platform: "signal",
    workerEntrypoint: join(MODULE_DIRNAME, "../signal/sync/worker.js"),
    workerTimeoutMs: 60_000,
  },
  whatsapp: {
    platform: "whatsapp",
    workerEntrypoint: join(MODULE_DIRNAME, "../whatsapp/sync/worker.js"),
    workerTimeoutMs: 60_000,
  },
};

export function listAdapterPlatforms(): AdapterPlatform[] {
  return [...ADAPTER_PLATFORM_VALUES];
}

export function getAdapterDefinition(platform: string): AdapterDefinition | null {
  return isAdapterPlatform(platform) ? ADAPTER_DEFINITIONS[platform] : null;
}
