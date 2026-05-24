import { runAdapterWorkerSync } from "../core/adapter-worker.js";
import { buildContactsSyncBundle } from "./sync.js";

runAdapterWorkerSync(() => buildContactsSyncBundle());
