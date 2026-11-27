#!/usr/bin/env node
// Builds the runtime that ships in Cued.app/Contents/Resources/cued-runtime.
//
// The CLI, the daemon and every process or thread they start load from a handful of bundled
// files instead of thousands of compiled modules and packages:
//
//   dist/<entry>.js      one file per entry point, at the same path tsc would emit it
//   dist/chunks/*.js     code shared between entry points
//   node_modules/        only what cannot be bundled (native addon, Playwright), pruned
//   package.json         name, version and module type; read for the app version
//
// Entry points keep their tsc paths because code finds them by path: the adapter registry
// spawns platform workers by file, the database worker thread is started by URL, sign-in
// spawns its browser and OAuth processes by file, and the updater and the native host match
// `dist/cli.js daemon` in process lists. Code that derives paths from `import.meta.url`
// (bundled scripts, helpers, skills, package.json) is rewritten to see the URL the module
// would have had unbundled, so every such lookup resolves exactly as before.
//
// Usage: node scripts/bundle-cued-runtime.mjs <output-dir>

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT_DIR, "src");

/**
 * Every file the runtime starts as a separate process or thread, relative to src/. A file
 * missing here would be absent from the bundle and fail only when that process is started,
 * so the release validation checks each of them exists in the built app.
 */
export const RUNTIME_ENTRY_POINTS = [
  // CLI, daemon (`cli.js daemon`) and projection worker (`cli.js __projection-worker`).
  "cli.ts",
  // Database worker thread: src/db/db-worker.ts.
  "db/db-worker-thread.ts",
  // Platform sync workers: src/platforms/core/registry.ts.
  "platforms/imessage/worker.ts",
  "platforms/discord/sync/worker.ts",
  "platforms/contacts/worker.ts",
  "platforms/gmail/sync/worker.ts",
  "platforms/linkedin/sync/worker.ts",
  "platforms/slack/sync/worker.ts",
  "platforms/signal/sync/worker.ts",
  "platforms/whatsapp/sync/worker.ts",
  // Sign-in browser process: src/platforms/core/auth/chromium.ts.
  "platforms/core/auth/chromium-worker.ts",
  // OAuth callback process, which re-runs its own file: src/platforms/core/auth/oauth.ts.
  "platforms/core/auth/oauth.ts",
];

/**
 * Packages left as real files in node_modules. better-sqlite3 loads its native addon through
 * `bindings`, which locates the .node file from the calling file's path; Playwright resolves
 * its own files and protocol assets relative to its install directory. Both only work from
 * their package layout. `better-sqlite3` is what drizzle-orm imports; it is the same package.
 */
const EXTERNAL_PACKAGES = ["better-sqlite3-multiple-ciphers", "playwright-core"];
const PACKAGE_ALIASES = { "better-sqlite3": "better-sqlite3-multiple-ciphers" };

/** Files and directories of the external packages the runtime never reads. */
const EXTERNAL_PACKAGE_PRUNE = {
  // The compiled addon is kept on its own (see copyExternalPackage); the rest of build/ is
  // the native build tree, and deps/ and src/ are its C sources.
  "better-sqlite3-multiple-ciphers": [
    "build",
    "deps",
    "src",
    "binding.gyp",
    "index.d.ts",
    "README.md",
  ],
  // `types` is TypeScript only; `lib/vite` holds the trace viewer and recorder web apps.
  "playwright-core": ["types", "lib/vite", "README.md"],
};

/** Files restored after pruning. */
const EXTERNAL_PACKAGE_KEEP = {
  "better-sqlite3-multiple-ciphers": ["build/Release/better_sqlite3.node"],
};

function toPosix(path) {
  return path.split(sep).join(posix.sep);
}

function outputPathFor(sourcePath) {
  return toPosix(relative(SRC_DIR, sourcePath)).replace(/\.(m|c)?tsx?$/, ".js");
}

/**
 * Rewrites `import.meta.url`, `import.meta.filename` and `import.meta.dirname` in our own
 * modules to the location the module would have unbundled. `__cuedDistRoot` is declared at
 * the top of every output file (see addDistRootPrologue), pointing at the dist directory.
 */
const importMetaLocationPlugin = {
  name: "cued-import-meta-location",
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, (args) => {
      if (!args.path.startsWith(SRC_DIR + sep)) {
        return undefined;
      }
      const source = readFileSync(args.path, "utf8");
      if (!source.includes("import.meta")) {
        return undefined;
      }
      const outputPath = JSON.stringify(outputPathFor(args.path));
      const moduleUrl = `new URL(${outputPath}, __cuedDistRoot)`;
      const contents = source
        .replaceAll("import.meta.url", `${moduleUrl}.href`)
        .replaceAll("import.meta.filename", `__cuedFileURLToPath(${moduleUrl})`)
        .replaceAll("import.meta.dirname", `__cuedDirname(__cuedFileURLToPath(${moduleUrl}))`);
      if (
        /import\.meta(?!\.(url|filename|dirname))/.test(contents.replaceAll("import.meta.env", ""))
      ) {
        throw new Error(`Unsupported import.meta use in ${args.path}`);
      }
      return { contents, loader: "ts" };
    });
  },
};

function addDistRootPrologue(outputFile, distDir) {
  const depth = toPosix(relative(distDir, dirname(outputFile)));
  const rootFromFile =
    depth === ""
      ? "./"
      : `${depth
          .split("/")
          .map(() => "..")
          .join("/")}/`;
  const prologue = [
    `import { fileURLToPath as __cuedFileURLToPath } from "node:url";`,
    `import { dirname as __cuedDirname } from "node:path";`,
    `const __cuedDistRoot = new URL(${JSON.stringify(rootFromFile)}, import.meta.url);`,
    "",
  ].join("\n");
  const code = readFileSync(outputFile, "utf8");
  const shebang = code.startsWith("#!") ? code.slice(0, code.indexOf("\n") + 1) : "";
  writeFileSync(outputFile, `${shebang}${prologue}${code.slice(shebang.length)}`);
}

function packageDirFor(file) {
  const marker = `${sep}node_modules${sep}`;
  const index = file.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }
  const rest = file.slice(index + marker.length).split(sep);
  const nameParts = rest[0].startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  return file.slice(0, index + marker.length) + nameParts.join(sep);
}

function readLicense(packageDir) {
  const name = readdirSync(packageDir).find((entry) => /^(licen[cs]e|copying)(\.|$)/i.test(entry));
  return name ? readFileSync(join(packageDir, name), "utf8").trim() : null;
}

/** License texts of the packages bundled into dist/, which no longer ship their own files. */
function writeBundledLicenses(metafile, outDir) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const packageDir = packageDirFor(resolve(ROOT_DIR, input));
    if (!packageDir || packages.has(packageDir)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    packages.set(packageDir, manifest);
  }
  const sections = [...packages.entries()]
    .sort(([, left], [, right]) => left.name.localeCompare(right.name))
    .map(([packageDir, manifest]) => {
      const license = readLicense(packageDir) ?? `License: ${manifest.license ?? "unknown"}`;
      return `${manifest.name}@${manifest.version}\n\n${license}\n`;
    });
  writeFileSync(
    join(outDir, "THIRD_PARTY_LICENSES"),
    `Third-party packages bundled into dist/.\n\n${sections.join(`\n${"-".repeat(72)}\n\n`)}`,
  );
  return [...packages.values()].map((manifest) => manifest.name);
}

/** Copies a package and the packages it requires at run time, resolved from the repo. */
function copyExternalPackage(name, fromDir, nodeModulesDir, copied) {
  if (copied.has(name)) {
    return;
  }
  const require = createRequire(join(fromDir, "noop.js"));
  const packageDir = dirname(require.resolve(`${name}/package.json`));
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const destination = join(nodeModulesDir, name);
  copied.add(name);
  cpSync(packageDir, destination, { recursive: true, dereference: true });
  for (const entry of EXTERNAL_PACKAGE_PRUNE[name] ?? []) {
    rmSync(join(destination, entry), { recursive: true, force: true });
  }
  for (const file of EXTERNAL_PACKAGE_KEEP[name] ?? []) {
    if (!existsSync(join(packageDir, file))) {
      throw new Error(`${name} is missing ${file}; was it built (pnpm install)?`);
    }
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    cpSync(join(packageDir, file), join(destination, file));
  }
  rmSync(join(destination, "node_modules"), { recursive: true, force: true });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    // better-sqlite3 depends on prebuild-install only for its install script.
    if (name === "better-sqlite3-multiple-ciphers" && dependency === "prebuild-install") {
      continue;
    }
    copyExternalPackage(dependency, packageDir, nodeModulesDir, copied);
  }
}

function removeFiles(dir, predicate) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      removeFiles(path, predicate);
    } else if (predicate(path)) {
      rmSync(path);
    }
  }
}

export async function bundleCuedRuntime(outDir) {
  const { build } = await import("esbuild");
  const distDir = join(outDir, "dist");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const result = await build({
    absWorkingDir: ROOT_DIR,
    entryPoints: RUNTIME_ENTRY_POINTS.map((entry) => join(SRC_DIR, entry)),
    outbase: SRC_DIR,
    outdir: distDir,
    entryNames: "[dir]/[name]",
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    tsconfig: join(ROOT_DIR, "tsconfig.json"),
    external: [...EXTERNAL_PACKAGES, ...Object.keys(PACKAGE_ALIASES)],
    alias: PACKAGE_ALIASES,
    // Prefer packages' ESM builds; CommonJS would need a require shim in every output file.
    mainFields: ["module", "main"],
    // Bundling renames clashing top-level names; keep `.name` as it was (error telemetry reads it).
    keepNames: true,
    legalComments: "none",
    charset: "utf8",
    metafile: true,
    logLevel: "warning",
    plugins: [importMetaLocationPlugin],
  });

  for (const outputFile of Object.keys(result.metafile.outputs)) {
    addDistRootPrologue(resolve(ROOT_DIR, outputFile), distDir);
  }
  for (const [outputFile, output] of Object.entries(result.metafile.outputs)) {
    // An esbuild CommonJS wrapper calling require() fails at run time in ESM output.
    if (readFileSync(resolve(ROOT_DIR, outputFile), "utf8").includes("Dynamic require of")) {
      throw new Error(`${outputFile} bundles CommonJS that calls require(); make it external`);
    }
    for (const imported of output.imports) {
      const name = imported.path
        .split("/")
        .slice(0, imported.path.startsWith("@") ? 2 : 1)
        .join("/");
      if (
        imported.external &&
        !imported.path.startsWith("node:") &&
        !EXTERNAL_PACKAGES.includes(name)
      ) {
        throw new Error(
          `${outputFile} imports ${imported.path}, which is neither bundled nor shipped`,
        );
      }
    }
  }

  const bundledPackages = writeBundledLicenses(result.metafile, outDir);
  const nodeModulesDir = join(outDir, "node_modules");
  const copied = new Set();
  for (const name of EXTERNAL_PACKAGES) {
    copyExternalPackage(name, ROOT_DIR, nodeModulesDir, copied);
  }
  removeFiles(
    nodeModulesDir,
    (path) => /\.(d\.ts|d\.mts|d\.cts|map|md)$/i.test(path) && !/licen[cs]e/i.test(path),
  );

  const rootManifest = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8"));
  writeFileSync(
    join(outDir, "package.json"),
    `${JSON.stringify(
      {
        name: rootManifest.name,
        version: rootManifest.version,
        license: rootManifest.license,
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  cpSync(join(ROOT_DIR, "LICENSE"), join(outDir, "LICENSE"));

  for (const entry of RUNTIME_ENTRY_POINTS) {
    const path = join(distDir, entry.replace(/\.ts$/, ".js"));
    if (!existsSync(path)) {
      throw new Error(`Bundle is missing entry point ${path}`);
    }
  }
  return { bundledPackages, externalPackages: [...copied] };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: node scripts/bundle-cued-runtime.mjs <output-dir>");
    process.exit(1);
  }
  const { bundledPackages, externalPackages } = await bundleCuedRuntime(resolve(outDir));
  console.log(`bundled: ${bundledPackages.join(", ") || "(none)"}`);
  console.log(`external: ${externalPackages.join(", ")}`);
}
