import { execFileSync } from "node:child_process";
import { cuedAuthKeychainService } from "../../../core/identity.js";
import type { Platform } from "../../../core/types/provider.js";
import { openCuedDatabaseReadOnly } from "../../../db/database.js";

export interface IntegrationSecretPayload {
  keychainService: string;
  keychainAccount: string;
  metadata: Record<string, unknown>;
  secret: Record<string, unknown>;
}

export function authKeychainService(platform: Platform): string {
  return cuedAuthKeychainService(platform);
}

export function loadKeychainSecret(
  service: string,
  account: string,
): Record<string, unknown> | null {
  try {
    const stdout = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function storeKeychainSecret(
  service: string,
  account: string,
  secret: Record<string, unknown>,
): void {
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-s", service, "-a", account, "-w", JSON.stringify(secret)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

export function loadIntegrationSecret(
  platform: Platform,
  accountKey: string,
): IntegrationSecretPayload {
  const db = openCuedDatabaseReadOnly();
  try {
    const integration = db.getIntegrationState(platform, accountKey);
    if (!integration?.metadata_json) {
      throw new Error(
        `${platform} integration not found or not authenticated for account '${accountKey}'`,
      );
    }

    const metadata = JSON.parse(integration.metadata_json) as Record<string, unknown>;
    const keychainService =
      typeof metadata.keychainService === "string" ? metadata.keychainService : null;
    const keychainAccount =
      typeof metadata.keychainAccount === "string" ? metadata.keychainAccount : null;

    if (!keychainService || !keychainAccount) {
      throw new Error(
        `${platform} integration '${accountKey}' does not have stored Keychain credentials`,
      );
    }

    const secret = loadKeychainSecret(keychainService, keychainAccount);
    if (!secret) {
      throw new Error(
        `${platform} integration '${accountKey}' is missing stored Keychain credentials`,
      );
    }

    return {
      keychainService,
      keychainAccount,
      metadata,
      secret,
    };
  } finally {
    db.close();
  }
}
