import { readFileSync } from "node:fs";
import { app, safeStorage } from "electron";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error("Usage: electron safe-storage-decrypt.mjs <encrypted-file>");
  }

  if (process.env.CUED_SAFE_STORAGE_APP_NAME) {
    app.setName(process.env.CUED_SAFE_STORAGE_APP_NAME);
  }

  await app.whenReady();

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage is not available");
  }

  const encrypted = readFileSync(filePath);
  const decrypted = safeStorage.decryptString(encrypted);
  process.stdout.write(decrypted);
  app.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.exit(1);
});
