#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const root = new URL("../", import.meta.url);
const failOnDrift = process.argv.includes("--fail-on-drift");
const execFileAsync = promisify(execFile);

const pinnedSources = [
  {
    name: "whatsmeow",
    repo: "tulir/whatsmeow",
    kind: "go-module",
    file: "native/helpers/whatsapp-go/go.mod",
    module: "go.mau.fi/whatsmeow",
    contract: "native/helpers/whatsapp-go protocol structs, auth/session, media, history sync",
  },
  {
    name: "signal-cli",
    repo: "AsamK/signal-cli",
    kind: "release",
    file: "scripts/fetch-signal-cli-macos.sh",
    versionPattern: /SIGNAL_VERSION="([^"]+)"/,
    tagPrefix: "v",
    contract: "scripts/fetch-signal-cli-macos.sh bundled helper, Signal auth/send/receive",
  },
  {
    name: "slack-go",
    repo: "slack-go/slack",
    kind: "go-module",
    file: "native/helpers/slack-go/go.mod",
    module: "github.com/slack-go/slack",
    contract: "native/helpers/slack-go Slack RTM/Web API helper",
  },
];

const watchOnlySources = [
  "mautrix/whatsapp",
  "mautrix/signal",
  "mautrix/slack",
  "mautrix/discord",
  "mautrix/imessage",
  "mautrix/linkedin",
  "signalapp/libsignal",
  "openclaw/wacli",
  "openclaw/imsg",
  "openclaw/discrawl",
  "openclaw/notcrawl",
  "openclaw/gogcli",
  "openclaw/gitcrawl",
  "openclaw/openclaw",
  "steipete/wacrawl",
  "steipete/slacrawl",
  "beeper/bridge-manager",
];

function repoUrl(repo) {
  return `https://api.github.com/repos/${repo}`;
}

async function githubJson(url) {
  const apiPath = url.replace("https://api.github.com", "");
  try {
    const { stdout } = await execFileAsync("gh", ["api", apiPath], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    // Fall through to unauthenticated fetch for environments without gh auth.
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "cued-upstream-monitor",
    },
  });
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function readRepoFile(path) {
  return readFile(join(root.pathname, path), "utf8");
}

async function localVersion(source) {
  const content = await readRepoFile(source.file);
  if (source.kind === "go-module") {
    const escaped = source.module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^\\s*${escaped}\\s+(\\S+)`, "m").exec(content);
    if (!match) {
      throw new Error(`Could not find ${source.module} in ${source.file}`);
    }
    return match[1];
  }
  const match = source.versionPattern.exec(content);
  if (!match) {
    throw new Error(`Could not find version in ${source.file}`);
  }
  return `${source.tagPrefix ?? ""}${match[1]}`;
}

function tagSemver(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(tag);
  return match ? match.slice(1).map((part) => Number(part)) : null;
}

function compareSemver(left, right) {
  const a = tagSemver(left);
  const b = tagSemver(right);
  if (!a || !b) {
    return left === right ? 0 : NaN;
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

function pseudoVersionCommit(version) {
  const match = /-([0-9a-f]{12})$/i.exec(version);
  return match?.[1] ?? null;
}

async function latestReleaseTag(repo) {
  const releases = await githubJson(`${repoUrl(repo)}/releases?per_page=10`);
  return releases.find((release) => !release.draft)?.tag_name ?? null;
}

async function defaultBranchHead(repo) {
  const details = await githubJson(repoUrl(repo));
  const branch = await githubJson(`${repoUrl(repo)}/branches/${details.default_branch}`);
  return {
    branch: details.default_branch,
    sha: branch.commit.sha,
    pushedAt: details.pushed_at,
  };
}

function classifyPinnedDrift(local, latestTag, head) {
  const localPseudo = pseudoVersionCommit(local);
  if (localPseudo) {
    return head.sha.startsWith(localPseudo)
      ? { status: "ok", detail: `pinned to default head ${localPseudo}` }
      : {
          status: "drift",
          detail: `local pseudo-version ${localPseudo}, ${head.branch} head ${head.sha.slice(0, 12)}`,
        };
  }

  if (!latestTag) {
    return { status: "unknown", detail: "no latest release tag found" };
  }

  const comparison = compareSemver(local, latestTag);
  if (Number.isNaN(comparison)) {
    return local === latestTag
      ? { status: "ok", detail: `matches ${latestTag}` }
      : { status: "drift", detail: `local ${local}, latest ${latestTag}` };
  }
  return comparison < 0
    ? { status: "drift", detail: `local ${local}, latest ${latestTag}` }
    : { status: "ok", detail: `local ${local}, latest ${latestTag}` };
}

async function inspectPinned(source) {
  try {
    const [local, latestTag, head] = await Promise.all([
      localVersion(source),
      latestReleaseTag(source.repo).catch(() => null),
      defaultBranchHead(source.repo),
    ]);
    return {
      ...source,
      local,
      latestTag,
      head,
      ...classifyPinnedDrift(local, latestTag, head),
    };
  } catch (error) {
    return {
      ...source,
      local: await localVersion(source).catch(() => "unknown"),
      latestTag: null,
      head: null,
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function inspectWatchOnly(repo) {
  try {
    const [latestTag, head] = await Promise.all([
      latestReleaseTag(repo).catch(() => null),
      defaultBranchHead(repo),
    ]);
    return { repo, latestTag, head, status: "watch" };
  } catch (error) {
    return {
      repo,
      latestTag: null,
      head: null,
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function printPinned(result) {
  const marker = result.status === "drift" ? "DRIFT" : result.status.toUpperCase();
  console.log(`${marker} ${result.name} (${result.repo})`);
  console.log(`  local: ${result.local}`);
  console.log(`  latest release: ${result.latestTag ?? "none"}`);
  if (result.head) {
    console.log(
      `  ${result.head.branch}: ${result.head.sha.slice(0, 12)} @ ${result.head.pushedAt}`,
    );
  }
  console.log(`  contract: ${result.contract}`);
  console.log(`  detail: ${result.detail}`);
}

function printWatchOnly(result) {
  console.log(`${result.status === "unknown" ? "UNKNOWN" : "WATCH"} ${result.repo}`);
  console.log(`  latest release: ${result.latestTag ?? "none"}`);
  if (result.head) {
    console.log(
      `  ${result.head.branch}: ${result.head.sha.slice(0, 12)} @ ${result.head.pushedAt}`,
    );
  }
  if (result.detail) {
    console.log(`  detail: ${result.detail}`);
  }
}

const pinnedResults = [];
const watchResults = [];
for (const source of pinnedSources) {
  pinnedResults.push(await inspectPinned(source));
  await delay(75);
}
for (const repo of watchOnlySources) {
  watchResults.push(await inspectWatchOnly(repo));
  await delay(75);
}

console.log("# Cued upstream integration monitor");
console.log(`checked_at: ${new Date().toISOString()}`);
console.log("");
for (const result of pinnedResults) {
  printPinned(result);
  console.log("");
}
for (const result of watchResults) {
  printWatchOnly(result);
  console.log("");
}

const drift = pinnedResults.filter((result) => result.status === "drift");
if (drift.length > 0) {
  console.error(`Detected ${drift.length} pinned upstream drift item(s).`);
  process.exitCode = failOnDrift ? 1 : 0;
}
