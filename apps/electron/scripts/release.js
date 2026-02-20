/**
 * Release script that loads .env before running electron-builder.
 *
 * Builds app artifacts locally, then uploads them to GitHub Releases using gh CLI.
 * Creates a draft release if needed and overwrites matching assets on upload.
 *
 * Required env vars (set via environment or apps/electron/.env):
 * - GH_TOKEN: GitHub Personal Access Token (for publishing to GitHub Releases)
 * - APPLE_ID: Apple ID email (for notarization)
 * - APPLE_APP_SPECIFIC_PASSWORD: App-specific password (for notarization)
 * - APPLE_TEAM_ID: Apple Developer Team ID (for notarization)
 */

const { execSync } = require("child_process");
const path = require("path");

// Load .env from the electron app directory
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const required = ["GH_TOKEN"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  console.error(
    "Set them in your environment or create apps/electron/.env with:"
  );
  console.error("  GH_TOKEN=ghp_...");
  process.exit(1);
}

const cwd = path.resolve(__dirname, "..");
const releaseRepo = "Cue-d/cued-releases";

// Build the app (without publishing — electron-builder just produces artifacts)
execSync("electron-vite build && electron-builder --mac --publish never", {
  stdio: "inherit",
  env: process.env,
  cwd,
  shell: true,
});

// Upload artifacts via gh CLI which handles existing releases gracefully
const pkg = require(path.join(cwd, "package.json"));
const tag = `v${pkg.version}`;
const distDir = path.join(cwd, "dist");

console.log(`\nUploading artifacts for ${tag}...`);
try {
  const releaseExists = (() => {
    try {
      execSync(`gh release view "${tag}" --repo ${releaseRepo}`, {
        stdio: "ignore",
        env: process.env,
        shell: true,
      });
      return true;
    } catch {
      return false;
    }
  })();

  if (!releaseExists) {
    // Create the release if it doesn't exist (--draft so it's not visible until ready)
    execSync(
      `gh release create "${tag}" --repo ${releaseRepo} --draft --title "${tag}" --notes "Cued ${tag}"`,
      { stdio: "inherit", env: process.env, shell: true }
    );
  } else {
    console.log(`Release ${tag} already exists; reusing it`);
  }

  // Upload/overwrite all distributable artifacts
  execSync(
    `gh release upload "${tag}" --repo ${releaseRepo} --clobber "${distDir}"/*.dmg "${distDir}"/*.zip "${distDir}"/*.yml "${distDir}"/*.blockmap`,
    { stdio: "inherit", env: process.env, shell: true }
  );
  console.log(`Artifacts uploaded to ${tag}`);
} catch (err) {
  console.error("Release upload failed:", err.message);
  process.exit(1);
}
