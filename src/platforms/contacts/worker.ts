import { runAdapterWorkerSync } from "../core/utils.js";
import { buildContactsSyncBundle } from "./sync.js";

runAdapterWorkerSync(() => buildContactsSyncBundle());
