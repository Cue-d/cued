import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// Runs before each test file imports runtime modules, whose paths are constants.
// A temporary database alone does not isolate integration deletion or log writes.
const testHome = mkdtempSync(join(tmpdir(), "cued-test-home-"));
for (const name of Object.keys(process.env)) {
  if (name.startsWith("CUED_")) delete process.env[name];
}
process.env.CUED_HOME = testHome;
process.env.CUED_DB_KEY = "cued-isolated-test-key";
const testUserHome = join(testHome, "user");
mkdirSync(testUserHome, { mode: 0o700 });

// Cover in-process OS-path fallbacks without changing the shell HOME variable.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: vi.fn(() => testUserHome),
}));

// Auth tests must provide their own fake security executable or module mock.
// The worker DB key already avoids Keychain, but auth helpers use it separately.
const binDir = join(testHome, "test-bin");
mkdirSync(binDir, { mode: 0o700 });
writeFileSync(join(binDir, "security"), "#!/bin/sh\nexit 77\n", { mode: 0o700 });
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
