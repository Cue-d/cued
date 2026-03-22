import { join } from "node:path";
import {
  ADAPTER_PLATFORM_VALUES,
  type AdapterPlatform,
  isAdapterPlatform,
} from "../../core/types/provider.js";

export { isAdapterPlatform } from "../../core/types/provider.js";

export interface AdapterDefinition {
  platform: AdapterPlatform;
  workerEntrypoint: string;
  autoSync: boolean;
  workerTimeoutMs: number;
}

const ADAPTER_DEFINITIONS: Record<AdapterPlatform, AdapterDefinition> = {
  imessage: {
    platform: "imessage",
    workerEntrypoint: join(import.meta.dirname, "../imessage/worker.js"),
    autoSync: true,
    workerTimeoutMs: 120_000,
  },
  contacts: {
    platform: "contacts",
    workerEntrypoint: join(import.meta.dirname, "../contacts/worker.js"),
    autoSync: true,
    workerTimeoutMs: 30_000,
  },
  linkedin: {
    platform: "linkedin",
    workerEntrypoint: join(import.meta.dirname, "../linkedin/sync/worker.js"),
    autoSync: true,
    workerTimeoutMs: 120_000,
  },
  slack: {
    platform: "slack",
    workerEntrypoint: join(import.meta.dirname, "../slack/sync/worker.js"),
    autoSync: true,
    workerTimeoutMs: 600_000,
  },
  signal: {
    platform: "signal",
    workerEntrypoint: join(import.meta.dirname, "../signal/sync/worker.js"),
    autoSync: true,
    workerTimeoutMs: 60_000,
  },
  whatsapp: {
    platform: "whatsapp",
    workerEntrypoint: join(import.meta.dirname, "../whatsapp/sync/worker.js"),
    autoSync: true,
    workerTimeoutMs: 60_000,
  },
};

export function listAdapterPlatforms(): AdapterPlatform[] {
  return [...ADAPTER_PLATFORM_VALUES];
}

export function listAutoSyncPlatforms(): AdapterPlatform[] {
  return Object.values(ADAPTER_DEFINITIONS)
    .filter((definition) => definition.autoSync)
    .map((definition) => definition.platform);
}

export function getAdapterDefinition(platform: string): AdapterDefinition | null {
  return isAdapterPlatform(platform) ? ADAPTER_DEFINITIONS[platform] : null;
}
