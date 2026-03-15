import type { Cookie } from "../api/types.js";
import { loadIntegrationSecret } from "../../core/secrets/keychain.js";

export interface LinkedInSessionSecret {
  cookies: Cookie[];
  pageInstance: string | null;
  xLiTrack: string | null;
  serviceVersion: string | null;
  realtimeQueryMap: string | null;
  realtimeRecipeMap: string | null;
  savedAt: number | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function parseLinkedInSessionSecret(secret: Record<string, unknown>): LinkedInSessionSecret {
  const cookies = Array.isArray(secret.cookies) ? (secret.cookies as Cookie[]) : [];
  return {
    cookies,
    pageInstance: asString(secret.pageInstance),
    xLiTrack: asString(secret.xLiTrack),
    serviceVersion: asString(secret.serviceVersion),
    realtimeQueryMap: asString(secret.realtimeQueryMap),
    realtimeRecipeMap: asString(secret.realtimeRecipeMap),
    savedAt: typeof secret.savedAt === "number" ? secret.savedAt : null,
  };
}

export function loadLinkedInSessionSecret(accountKey: string): LinkedInSessionSecret {
  return parseLinkedInSessionSecret(loadIntegrationSecret("linkedin", accountKey).secret);
}
