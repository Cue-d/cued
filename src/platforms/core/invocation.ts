import { safeParseJsonRecord } from "../../db/codecs.js";
import type { AdapterPlatform } from "./types.js";

export type AdapterInvocationProofRow = {
  scope_kind: string;
  scope_key: string;
  proof_kind: string;
  status: string;
  resume_cursor_json: string | null;
  coverage_json: string | null;
  stats_json: string | null;
  last_observed_at: number;
};

export function buildAdapterInvocationEnv(input: {
  platform: AdapterPlatform;
  checkpointSourceCursorJson?: string | null;
  proofs?: AdapterInvocationProofRow[];
}): Record<string, string> {
  const env: Record<string, string> = {};
  const platformEnvPrefix = `CUED_${input.platform.toUpperCase()}_`;
  const sourceCursor = safeParseJsonRecord(
    input.checkpointSourceCursorJson ?? null,
    "sync_checkpoints.source_cursor_json",
  );

  if (input.checkpointSourceCursorJson) {
    env.CUED_SYNC_SOURCE_CURSOR = input.checkpointSourceCursorJson;
    env[`${platformEnvPrefix}SOURCE_CURSOR`] = input.checkpointSourceCursorJson;
  }
  if (input.proofs && input.proofs.length > 0) {
    const proofsJson = JSON.stringify(input.proofs.map(serializeInvocationProof));
    env.CUED_SYNC_PROOFS = proofsJson;
    if (input.platform === "discord") {
      env.CUED_DISCORD_SYNC_PROOFS = proofsJson;
    }
  }

  if (input.platform === "imessage" && typeof sourceCursor?.rowId === "number") {
    env.CUED_IMESSAGE_LAST_ROWID = String(sourceCursor.rowId);
  }
  if (input.platform === "slack" && typeof sourceCursor?.lastSyncAt === "number") {
    env.CUED_SLACK_LAST_SYNC_AT = String(sourceCursor.lastSyncAt);
  }
  if (input.platform === "linkedin") {
    if (typeof sourceCursor?.lastSyncAt === "number") {
      env.CUED_LINKEDIN_LAST_SYNC_AT = String(sourceCursor.lastSyncAt);
    }
    if (typeof sourceCursor?.syncToken === "string" && sourceCursor.syncToken.length > 0) {
      env.CUED_LINKEDIN_SYNC_TOKEN = sourceCursor.syncToken;
    }
  }
  if (input.platform === "signal" && typeof sourceCursor?.lastSyncAt === "number") {
    env.CUED_SIGNAL_LAST_SYNC_AT = String(sourceCursor.lastSyncAt);
  }

  return env;
}

export function selectAdapterInvocationProofs(input: {
  platform: AdapterPlatform;
  proofs: AdapterInvocationProofRow[];
  sourceCursor?: unknown;
}): AdapterInvocationProofRow[] {
  if (input.platform === "slack") {
    const activeConversationId = getStringPath(input.sourceCursor, [
      "scan",
      "activeConversationId",
    ]);
    if (!activeConversationId) {
      return [];
    }
    return input.proofs.filter(
      (proof) =>
        proof.scope_kind === "conversation" &&
        proof.scope_key === activeConversationId &&
        (proof.proof_kind === "messages" || proof.proof_kind === "replies"),
    );
  }

  if (input.platform === "linkedin") {
    const activeConversationId = normalizeLinkedInConversationScopeKey(
      getStringPath(input.sourceCursor, ["scan", "activeConversation", "entityURN"]),
    );
    return input.proofs.filter((proof) => {
      if (
        proof.scope_kind === "account" &&
        proof.proof_kind === "discovery" &&
        proof.status === "running"
      ) {
        return true;
      }
      return (
        proof.scope_kind === "conversation" &&
        proof.proof_kind === "messages" &&
        proof.scope_key === activeConversationId
      );
    });
  }

  if (input.platform === "discord") {
    return input.proofs.filter(
      (proof) => proof.proof_kind === "latest_messages" || proof.proof_kind === "messages",
    );
  }

  return input.proofs.filter((proof) => proof.status === "running");
}

export function readAdapterInvocationEnv(
  platform: AdapterPlatform,
  env: NodeJS.ProcessEnv = process.env,
): {
  sourceCursor?: unknown;
  syncProofs?: unknown;
} {
  const platformEnvPrefix = `CUED_${platform.toUpperCase()}_`;
  return {
    sourceCursor: parseOptionalJsonEnv(
      env[`${platformEnvPrefix}SOURCE_CURSOR`] ?? env.CUED_SYNC_SOURCE_CURSOR,
    ),
    syncProofs: parseOptionalJsonEnv(
      env[`${platformEnvPrefix}SYNC_PROOFS`] ?? env.CUED_SYNC_PROOFS,
    ),
  };
}

function serializeInvocationProof(proof: AdapterInvocationProofRow): Record<string, unknown> {
  return {
    scopeKind: proof.scope_kind,
    scopeKey: proof.scope_key,
    proofKind: proof.proof_kind,
    status: proof.status,
    resumeCursor: safeParseJsonRecord(proof.resume_cursor_json, "sync_proofs.resume_cursor_json"),
    coverage: safeParseJsonRecord(proof.coverage_json, "sync_proofs.coverage_json"),
    stats: safeParseJsonRecord(proof.stats_json, "sync_proofs.stats_json"),
    lastObservedAt: proof.last_observed_at,
  };
}

function parseOptionalJsonEnv(value: string | undefined): unknown {
  return value ? JSON.parse(value) : undefined;
}

function getStringPath(value: unknown, path: string[]): string | null {
  let cursor = value;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

function normalizeLinkedInConversationScopeKey(value: string | null): string | null {
  return value
    ? value
        .replace(/^urn:li:fsd_conversation:/, "urn:li:fs_conversation:")
        .replace(/^urn:li:msg_conversation:/, "urn:li:fs_conversation:")
        .replace(/^urn:li:messagingThread:/, "urn:li:fs_conversation:")
    : null;
}
