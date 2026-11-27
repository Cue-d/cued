import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAdapterDefinition, listAdapterPlatforms } from "../platforms/core/registry.js";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SRC_DIR, "..");

type RuntimeBundler = {
  RUNTIME_ENTRY_POINTS: string[];
  bundleCuedRuntime: (
    outDir: string,
  ) => Promise<{ bundledPackages: string[]; externalPackages: string[] }>;
};

async function loadBundler(): Promise<RuntimeBundler> {
  const path = pathToFileURL(join(REPO_ROOT, "scripts", "bundle-cued-runtime.mjs")).href;
  return (await import(path)) as RuntimeBundler;
}

describe("bundled runtime entry points", () => {
  it("include every platform sync worker the registry spawns", async () => {
    const { RUNTIME_ENTRY_POINTS } = await loadBundler();
    for (const platform of listAdapterPlatforms()) {
      const definition = getAdapterDefinition(platform);
      expect(definition).not.toBeNull();
      const entry = relative(SRC_DIR, definition!.workerEntrypoint).replace(/\.js$/, ".ts");
      expect(RUNTIME_ENTRY_POINTS).toContain(entry);
    }
  });

  it("name source files that exist", async () => {
    const { RUNTIME_ENTRY_POINTS } = await loadBundler();
    for (const entry of RUNTIME_ENTRY_POINTS) {
      expect(existsSync(join(SRC_DIR, entry)), entry).toBe(true);
    }
  });
});

describe("bundled runtime", () => {
  let outDir: string;
  let home: string;

  beforeAll(async () => {
    outDir = realpathSync(mkdtempSync(join(tmpdir(), "cued-runtime-bundle-")));
    home = mkdtempSync(join(tmpdir(), "cued-runtime-home-"));
    const { bundleCuedRuntime } = await loadBundler();
    await bundleCuedRuntime(outDir);
  }, 60_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("ships only packages that cannot be bundled", () => {
    expect(readdirSync(join(outDir, "node_modules")).sort()).toEqual([
      "better-sqlite3-multiple-ciphers",
      "bindings",
      "file-uri-to-path",
      "playwright-core",
    ]);
    const manifest = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8")) as {
      type?: string;
      version?: string;
    };
    expect(manifest.type).toBe("module");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("resolves module-relative paths as the unbundled modules did", () => {
    // The registry is bundled away from src/platforms/core but must still find the workers.
    const registryFile = readdirSync(join(outDir, "dist"), { recursive: true, encoding: "utf8" })
      .map((file) => join(outDir, "dist", file))
      .filter((file) => file.endsWith(".js"))
      .find((file) => readFileSync(file, "utf8").includes("// src/platforms/core/registry.ts"));
    expect(registryFile).toBeDefined();
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          `const mod = await import(process.env.CUED_TEST_CHUNK_URL);`,
          `for (const value of Object.values(mod)) {`,
          `  if (typeof value === "function" && value.name === "getAdapterDefinition") {`,
          `    console.log(value("imessage").workerEntrypoint);`,
          `  }`,
          `}`,
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          CUED_HOME: join(home, ".cued"),
          CUED_TEST_CHUNK_URL: pathToFileURL(registryFile!).href,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(join(outDir, "dist", "platforms", "imessage", "worker.js"));
  });

  it("runs the CLI", () => {
    const result = spawnSync(process.execPath, [join(outDir, "dist", "cli.js"), "help"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, CUED_HOME: join(home, ".cued") },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("cued skill install-global|status");
  });
});
