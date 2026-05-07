import { readAdapterInvocationEnv } from "../../core/invocation.js";
import { buildSlackSyncBundle } from "./bundle.js";

async function main(): Promise<void> {
  try {
    const invocation = readAdapterInvocationEnv();
    const apiPageBudget = process.env.CUED_SLACK_API_PAGE_BUDGET
      ? Number(process.env.CUED_SLACK_API_PAGE_BUDGET)
      : undefined;
    const bundle = await buildSlackSyncBundle({
      accountKey: process.env.CUED_ACCOUNT_KEY,
      sourceCursor: invocation.sourceCursor,
      syncProofs: invocation.syncProofs,
      apiPageBudget: Number.isFinite(apiPageBudget) ? apiPageBudget : undefined,
    });
    process.stdout.write(JSON.stringify({ ok: true, bundle }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}

void main();
