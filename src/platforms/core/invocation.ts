import { safeParseJsonRecord } from "../../db/codecs.js";
import type { AdapterPlatform } from "./types.js";

export type AdapterInvocation = {
  accountKey?: string;
  sourceCursor?: unknown;
  syncProofs?: unknown;
  lastSyncAt?: number;
  syncToken?: string | null;
  imessageLastRowId?: number;
  whatsappSource?: "desktop_db";
  whatsappDesktopSourcePath?: string;
  slackHelperPath?: string | null;
  slackHelperApiUrl?: string;
};

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

export function buildAdapterInvocation(input: {
  platform: AdapterPlatform;
  accountKey?: string;
  checkpointSourceCursorJson?: string | null;
  proofs?: AdapterInvocationProofRow[];
}): AdapterInvocation {
  const invocation: AdapterInvocation = {};
  const sourceCursor = safeParseJsonRecord(
    input.checkpointSourceCursorJson ?? null,
    "sync_checkpoints.source_cursor_json",
  );

  if (input.accountKey) {
    invocation.accountKey = input.accountKey;
  }
  if (sourceCursor) {
    invocation.sourceCursor = sourceCursor;
  }
  if (input.proofs && input.proofs.length > 0) {
    invocation.syncProofs = input.proofs.map(serializeInvocationProof);
  }

  if (input.platform === "imessage" && typeof sourceCursor?.rowId === "number") {
    invocation.imessageLastRowId = sourceCursor.rowId;
  }
  if (input.platform === "slack" && typeof sourceCursor?.lastSyncAt === "number") {
    invocation.lastSyncAt = sourceCursor.lastSyncAt;
  }
  if (input.platform === "linkedin") {
    if (typeof sourceCursor?.lastSyncAt === "number") {
      invocation.lastSyncAt = sourceCursor.lastSyncAt;
    }
    if (typeof sourceCursor?.syncToken === "string" && sourceCursor.syncToken.length > 0) {
      invocation.syncToken = sourceCursor.syncToken;
    }
  }
  if (input.platform === "signal" && typeof sourceCursor?.lastSyncAt === "number") {
    invocation.lastSyncAt = sourceCursor.lastSyncAt;
  }

  return invocation;
}

export async function readAdapterInvocation(
  input: AsyncIterable<Buffer | string> | Iterable<Buffer | string> = process.stdin,
): Promise<AdapterInvocation> {
  const raw = await readText(input);
  return raw.trim() ? (JSON.parse(raw) as AdapterInvocation) : {};
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

async function readText(
  input: AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
