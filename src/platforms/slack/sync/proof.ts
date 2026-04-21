import type { SyncProofInput } from "../../../core/types/provider.js";

export type SlackBackfillConversationPhase = "history" | "threads" | "complete";

export interface SlackBackfillConversationProof {
  teamId: string;
  accountKey: string;
  syncMode: "full" | "incremental";
  scanStartedAt: number;
  knownConversationCount: number;
  conversationId: string;
  conversationName?: string;
  conversationFamily: "direct" | "channels";
  conversationPhase: SlackBackfillConversationPhase;
  historyComplete: boolean;
  historyCursor: string | null;
  threadRootCount: number;
  completedThreadCount: number;
  pendingThreadCount: number;
  activeThreadTs: string | null;
  repliesCursor: string | null;
  oldestMessageTs: string | null;
  newestMessageTs: string | null;
  observedAt: number;
}

export function isSlackBackfillConversationProof(
  value: unknown,
): value is SlackBackfillConversationProof {
  if (!value || typeof value !== "object") {
    return false;
  }

  const parsed = value as Record<string, unknown>;
  return (
    typeof parsed.teamId === "string" &&
    typeof parsed.accountKey === "string" &&
    (parsed.syncMode === "full" || parsed.syncMode === "incremental") &&
    typeof parsed.scanStartedAt === "number" &&
    typeof parsed.knownConversationCount === "number" &&
    typeof parsed.conversationId === "string" &&
    (parsed.conversationFamily === "direct" || parsed.conversationFamily === "channels") &&
    (parsed.conversationPhase === "history" ||
      parsed.conversationPhase === "threads" ||
      parsed.conversationPhase === "complete") &&
    typeof parsed.historyComplete === "boolean" &&
    typeof parsed.threadRootCount === "number" &&
    typeof parsed.completedThreadCount === "number" &&
    typeof parsed.pendingThreadCount === "number" &&
    typeof parsed.observedAt === "number"
  );
}

export function buildSlackBackfillSyncProofs(
  proof: SlackBackfillConversationProof,
): SyncProofInput[] {
  const scope = {
    kind: "conversation" as const,
    key: proof.conversationId,
    displayName: proof.conversationName ?? null,
    metadata: {
      teamId: proof.teamId,
      conversationFamily: proof.conversationFamily,
    },
  };
  const proofs: SyncProofInput[] = [
    {
      scope,
      proofKind: "messages",
      status:
        proof.historyComplete || proof.conversationPhase !== "history" ? "complete" : "running",
      syncMode: proof.syncMode,
      observedAt: proof.observedAt,
      completedAt:
        proof.historyComplete || proof.conversationPhase !== "history" ? proof.observedAt : null,
      resumeCursor:
        proof.historyComplete || proof.conversationPhase !== "history"
          ? null
          : {
              historyCursor: proof.historyCursor,
              conversationPhase: proof.conversationPhase,
            },
      coverage: {
        oldestMessageTs: proof.oldestMessageTs,
        newestMessageTs: proof.newestMessageTs,
      },
      stats: {
        knownConversationCount: proof.knownConversationCount,
        threadRootCount: proof.threadRootCount,
      },
    },
  ];

  if (
    proof.threadRootCount > 0 ||
    proof.conversationPhase === "threads" ||
    proof.conversationPhase === "complete"
  ) {
    proofs.push({
      scope,
      proofKind: "replies",
      status: proof.conversationPhase === "complete" ? "complete" : "running",
      syncMode: proof.syncMode,
      observedAt: proof.observedAt,
      completedAt: proof.conversationPhase === "complete" ? proof.observedAt : null,
      resumeCursor:
        proof.conversationPhase === "complete"
          ? null
          : {
              activeThreadTs: proof.activeThreadTs,
              repliesCursor: proof.repliesCursor,
              conversationPhase: proof.conversationPhase,
            },
      coverage: {
        oldestMessageTs: proof.oldestMessageTs,
        newestMessageTs: proof.newestMessageTs,
        completedThreadCount: proof.completedThreadCount,
        pendingThreadCount: proof.pendingThreadCount,
      },
      stats: {
        threadRootCount: proof.threadRootCount,
        completedThreadCount: proof.completedThreadCount,
        pendingThreadCount: proof.pendingThreadCount,
      },
    });
  }

  return proofs;
}
