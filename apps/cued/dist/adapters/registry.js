import { join } from "node:path";
import { ADAPTER_PLATFORM_VALUES, isAdapterPlatform, } from "../types/provider.js";
export { isAdapterPlatform } from "../types/provider.js";
const ADAPTER_DEFINITIONS = {
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
};
export function listAdapterPlatforms() {
    return [...ADAPTER_PLATFORM_VALUES];
}
export function listAutoSyncPlatforms() {
    return Object.values(ADAPTER_DEFINITIONS)
        .filter((definition) => definition.autoSync)
        .map((definition) => definition.platform);
}
export function getAdapterDefinition(platform) {
    return isAdapterPlatform(platform) ? ADAPTER_DEFINITIONS[platform] : null;
}
//# sourceMappingURL=registry.js.map