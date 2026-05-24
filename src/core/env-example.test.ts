import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PUBLIC_ENV_EXAMPLE_KEYS = [
  "CUED_DB_KEY",
  "CUED_GOOGLE_OAUTH_CLIENT_FILE",
  "GOOGLE_OAUTH_CLIENT_FILE",
  "CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE",
  "CUED_CODESIGN_IDENTITY",
  "CUED_NOTARY_PROFILE",
] as const;

function readEnvExampleKeys(): string[] {
  const contents = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  return contents
    .split("\n")
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
    .filter((key): key is string => typeof key === "string");
}

describe("public env example", () => {
  it("documents only credential-bearing public env values", () => {
    expect(readEnvExampleKeys()).toEqual([...PUBLIC_ENV_EXAMPLE_KEYS]);
  });
});
