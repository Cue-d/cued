import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

export function resolveCuedDotenvPath(
  startDir = dirname(fileURLToPath(import.meta.url)),
): string | null {
  let cursor = startDir;
  while (true) {
    const packageJsonPath = join(cursor, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
        if (parsed.name === "@cued/app") {
          const dotenvPath = join(cursor, ".env");
          return existsSync(dotenvPath) ? dotenvPath : null;
        }
      } catch {
        return null;
      }
    }

    const parent = dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }
}

const dotenvPath = resolveCuedDotenvPath();
if (dotenvPath) {
  loadDotenv({ path: dotenvPath });
}
