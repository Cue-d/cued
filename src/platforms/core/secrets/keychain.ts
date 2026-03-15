import { execFileSync } from "node:child_process";
import type { Platform } from "../../../core/types/provider.js";
import { openCuedDatabase } from "../../../db/database.js";

export interface IntegrationSecretPayload {
  keychainService: string;
  keychainAccount: string;
  metadata: Record<string, unknown>;
  secret: Record<string, unknown>;
}

export function loadIntegrationSecret(
  platform: Platform,
  accountKey: string,
): IntegrationSecretPayload {
  const db = openCuedDatabase();
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

    const stdout = execFileSync(
      "security",
      ["find-generic-password", "-s", keychainService, "-a", keychainAccount, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    return {
      keychainService,
      keychainAccount,
      metadata,
      secret: JSON.parse(stdout) as Record<string, unknown>,
    };
  } finally {
    db.close();
  }
}
