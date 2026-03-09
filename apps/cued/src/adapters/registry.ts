import { join } from "node:path";
import {
  ADAPTER_PLATFORM_VALUES,
  type AdapterPlatform,
  isAdapterPlatform,
} from "../types/provider.js";
export { isAdapterPlatform } from "../types/provider.js";

export interface AdapterDefinition {
  platform: AdapterPlatform;
  workerEntrypoint: string;
  autoSync: boolean;
}

const ADAPTER_DEFINITIONS: Record<AdapterPlatform, AdapterDefinition> = {
  fixture: {
    platform: "fixture",
    workerEntrypoint: join(import.meta.dirname, "../workers/fixture-worker.js"),
    autoSync: false,
  },
  imessage: {
    platform: "imessage",
    workerEntrypoint: join(import.meta.dirname, "../workers/imessage-worker.js"),
    autoSync: true,
  },
  contacts: {
    platform: "contacts",
    workerEntrypoint: join(import.meta.dirname, "../workers/contacts-worker.js"),
    autoSync: true,
  },
  slack: {
    platform: "slack",
    workerEntrypoint: join(import.meta.dirname, "../workers/slack-worker.js"),
    autoSync: true,
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
