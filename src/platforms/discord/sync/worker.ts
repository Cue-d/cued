import { runAdapterWorker } from "../../core/adapter-worker.js";
import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { buildDiscordSyncBundle } from "./bundle.js";

void runAdapterWorker(async () => {
  const invocation = readAdapterInvocationEnv("discord");
  return buildDiscordSyncBundle(
    {
      accountKey: process.env.CUED_ACCOUNT_KEY,
    },
    {
      sourceCursor: invocation.sourceCursor,
      syncProofs: invocation.syncProofs,
    },
  );
});
