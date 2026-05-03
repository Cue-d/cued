#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const distDir = join(rootDir, "native", "macos", "dist");

const version =
  process.env.CUED_RELEASE_VERSION ??
  JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).version;
const tag = process.env.CUED_RELEASE_TAG ?? `v${version}`;
const repo = process.env.CUED_RELEASE_REPO ?? "Cue-d/cued";
const channel = process.env.CUED_RELEASE_CHANNEL ?? "stable";
const publishedAt = process.env.CUED_RELEASE_PUBLISHED_AT ?? new Date().toISOString();

const artifactNames = {
  dmg: "Cued.dmg",
  tarball: "cued-macos-arm64.tar.gz",
};

if (!existsSync(join(distDir, "Cued.app"))) {
  throw new Error("Signed Cued.app is required before generating release metadata");
}
if (
  !existsSync(join(distDir, artifactNames.dmg)) ||
  !existsSync(join(distDir, artifactNames.tarball))
) {
  throw new Error("Signed release artifacts are required before generating release metadata");
}

const codesignResult = spawnSync("codesign", ["-dv", "--verbose=4", join(distDir, "Cued.app")], {
  encoding: "utf8",
});
if (codesignResult.status !== 0) {
  throw new Error(codesignResult.stderr || "Failed to inspect Cued.app code signature");
}
const codesignInfo = `${codesignResult.stdout ?? ""}\n${codesignResult.stderr ?? ""}`;
if (codesignInfo.includes("Signature=adhoc")) {
  throw new Error("Release metadata requires a non-adhoc signed Cued.app");
}

function sha256(fileName) {
  return createHash("sha256")
    .update(readFileSync(join(distDir, fileName)))
    .digest("hex");
}

const metadata = {
  version,
  tag,
  channel,
  architecture: "arm64",
  publishedAt,
  artifacts: {
    dmg: {
      name: artifactNames.dmg,
      url: `https://github.com/${repo}/releases/download/${tag}/${artifactNames.dmg}`,
      sha256: sha256(artifactNames.dmg),
    },
    tarball: {
      name: artifactNames.tarball,
      url: `https://github.com/${repo}/releases/download/${tag}/${artifactNames.tarball}`,
      sha256: sha256(artifactNames.tarball),
    },
  },
};

writeFileSync(join(distDir, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(
  join(distDir, "SHA256SUMS"),
  `${metadata.artifacts.dmg.sha256}  ${artifactNames.dmg}\n${metadata.artifacts.tarball.sha256}  ${artifactNames.tarball}\n`,
);
