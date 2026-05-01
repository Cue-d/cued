import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOAuthUrl,
  GMAIL_READONLY_SCOPE,
  readGoogleOAuthClientConfig,
  resolveGoogleOAuthClientFile,
} from "./client.js";

const ORIGINAL_ENV = { ...process.env };

function oauthClient(projectId: string) {
  return JSON.stringify({
    installed: {
      client_id: `${projectId}.apps.googleusercontent.com`,
      client_secret: "secret",
      project_id: projectId,
      auth_uri: "https://accounts.google.com/o/oauth2/v2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      redirect_uris: ["http://localhost"],
    },
  });
}

function writeClient(path: string, projectId: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, oauthClient(projectId), "utf8");
}

describe("Gmail OAuth client config", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("prefers explicit OAuth client file env vars", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-gmail-oauth-"));
    try {
      const explicitPath = join(dir, "explicit.json");
      const bundledPath = join(
        dir,
        "Cued.app",
        "Contents",
        "Resources",
        "oauth",
        "google-oauth-client.json",
      );
      writeClient(explicitPath, "explicit-project");
      writeClient(bundledPath, "bundled-project");
      process.env.CUED_GOOGLE_OAUTH_CLIENT_FILE = explicitPath;
      process.env.CUED_APP_PATH = join(dir, "Cued.app");

      expect(resolveGoogleOAuthClientFile()).toBe(explicitPath);
      expect(readGoogleOAuthClientConfig().config.clientId).toBe(
        "explicit-project.apps.googleusercontent.com",
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("falls back to the bundled app OAuth client when no user file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-gmail-oauth-"));
    try {
      const bundledPath = join(
        dir,
        "Cued.app",
        "Contents",
        "Resources",
        "oauth",
        "google-oauth-client.json",
      );
      writeClient(bundledPath, "bundled-project");
      process.env.HOME = join(dir, "home");
      process.env.CUED_APP_PATH = join(dir, "Cued.app");
      delete process.env.CUED_GOOGLE_OAUTH_CLIENT_FILE;
      delete process.env.GOOGLE_OAUTH_CLIENT_FILE;
      delete process.env.CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE;

      expect(resolveGoogleOAuthClientFile()).toBe(bundledPath);
      expect(readGoogleOAuthClientConfig().config.clientId).toBe(
        "bundled-project.apps.googleusercontent.com",
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("uses only the Gmail readonly scope in the OAuth URL", () => {
    const url = new URL(
      buildOAuthUrl({
        config: {
          clientId: "client.apps.googleusercontent.com",
          clientSecret: "secret",
          authUri: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUri: "https://oauth2.googleapis.com/token",
        },
        redirectUri: "http://localhost:1234",
        state: "state",
        codeChallenge: "challenge",
      }),
    );

    expect(url.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
