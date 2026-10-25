import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

// Run once against each checkout with the same real helper. No account/auth calls.
// pnpm exec tsx scripts/bench-signal-inspection.mts <client.ts|client.js> <helper> [requests]
const [moduleArgument, helperArgument, countArgument = "30"] = process.argv.slice(2);
const requests = Number(countArgument);
if (!moduleArgument || !helperArgument || !Number.isSafeInteger(requests) || requests < 1) {
  throw new Error("Usage: bench-signal-inspection.mts <client-module> <signal-helper> [requests]");
}
const source = resolve(moduleArgument);
const helper = resolve(helperArgument);
const root = mkdtempSync(join(tmpdir(), "cued-signal-inspection-bench-"));
const app = join(root, "Cued.app");
const wrapperRoot = join(app, "Contents", "Resources", "helpers", "signal-cli");
const calls = join(root, "calls");
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
try {
  mkdirSync(wrapperRoot, { recursive: true });
  writeFileSync(calls, "");
  const wrapper = join(wrapperRoot, "cued-signal-cli");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nprintf 'x\\n' >> ${shellQuote(calls)}\nexec ${shellQuote(helper)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  const { inspectSignalCli } = await import(pathToFileURL(source).href);
  const started = performance.now();
  let helperVersion: string | undefined;
  for (let i = 0; i < requests; i++) {
    const result = await inspectSignalCli({
      ...process.env,
      CUED_APP_PATH: app,
      CUED_HOME: join(root, "home"),
    });
    if (!result.version?.raw || (helperVersion && helperVersion !== result.version.raw)) {
      throw new Error("Helper inspection failed or returned inconsistent versions");
    }
    helperVersion = result.version.raw;
  }
  console.log(
    JSON.stringify({
      source,
      helperVersion,
      requests,
      processLaunches: readFileSync(calls, "utf8").trim().split("\n").length,
      elapsedMs: performance.now() - started,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
