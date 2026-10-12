import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { runAdapterWorker } from "../../core/utils.js";
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
