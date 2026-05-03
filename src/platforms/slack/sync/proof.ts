import type { SyncProofInput, SyncProofStatus } from "../../../core/types/provider.js";

export type SlackBackfillConversationPhase = "history" | "threads" | "complete";

export interface SlackBackfillProofError {
  code: string;
  message: string;
  retryable: boolean;
  kind?: string;
}

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
  pendingThreadTs?: string[];
  activeThreadTs: string | null;
  repliesCursor: string | null;
  oldestMessageTs: string | null;
  newestMessageTs: string | null;
  observedAt: number;
  historyError?: SlackBackfillProofError | null;
  repliesError?: SlackBackfillProofError | null;
  membersError?: SlackBackfillProofError | null;
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
  const messageStatus = getMessagesProofStatus(proof);
  const proofs: SyncProofInput[] = [
    {
      scope,
      proofKind: "messages",
      status: messageStatus,
      syncMode: proof.syncMode,
      observedAt: proof.observedAt,
      runStartedAt: proof.scanStartedAt,
      completedAt:
        messageStatus === "complete" || messageStatus === "partial" ? proof.observedAt : null,
      resumeCursor:
        messageStatus === "complete" || proof.historyError
          ? null
          : {
              historyCursor: proof.historyCursor,
              conversationPhase: proof.conversationPhase,
            },
      coverage: buildSlackMessageCoverage(proof),
      stats: {
        knownConversationCount: proof.knownConversationCount,
        ...(proof.threadRootCount > 0 ? { threadRootCount: proof.threadRootCount } : {}),
      },
      error: proof.historyError ?? proof.membersError ?? undefined,
    },
  ];

  if (
    proof.threadRootCount > 0 ||
    proof.completedThreadCount > 0 ||
    proof.pendingThreadCount > 0 ||
    proof.conversationPhase === "threads" ||
    proof.activeThreadTs != null ||
    proof.repliesCursor != null ||
    proof.repliesError
  ) {
    const repliesStatus = getRepliesProofStatus(proof);
    proofs.push({
      scope,
      proofKind: "replies",
      status: repliesStatus,
      syncMode: proof.syncMode,
      observedAt: proof.observedAt,
      runStartedAt: proof.scanStartedAt,
      completedAt:
        repliesStatus === "complete" || repliesStatus === "partial" ? proof.observedAt : null,
      resumeCursor:
        repliesStatus === "complete" || proof.repliesError || proof.historyError
          ? null
          : {
              activeThreadTs: proof.activeThreadTs,
              repliesCursor: proof.repliesCursor,
              pendingThreadTs: proof.pendingThreadTs ?? [],
              conversationPhase: proof.conversationPhase,
            },
      coverage: {
        ...buildSlackMessageCoverage(proof),
        completedThreadCount: proof.completedThreadCount,
        pendingThreadCount: proof.pendingThreadCount,
      },
      stats: {
        threadRootCount: proof.threadRootCount,
        completedThreadCount: proof.completedThreadCount,
        pendingThreadCount: proof.pendingThreadCount,
      },
      error: proof.repliesError ?? proof.historyError ?? undefined,
    });
  }

  return proofs;
}

function getMessagesProofStatus(proof: SlackBackfillConversationProof): SyncProofStatus {
  if (!proof.historyError) {
    return proof.historyComplete || proof.conversationPhase !== "history" ? "complete" : "running";
  }
  return proof.oldestMessageTs || proof.newestMessageTs ? "partial" : "blocked";
}

function getRepliesProofStatus(proof: SlackBackfillConversationProof): SyncProofStatus {
  if (!proof.repliesError && !proof.historyError) {
    return proof.conversationPhase === "complete" ? "complete" : "running";
  }
  return proof.completedThreadCount > 0 ? "partial" : "blocked";
}

function buildSlackMessageCoverage(
  proof: SlackBackfillConversationProof,
): Record<string, unknown> | undefined {
  const coverage = {
    ...(proof.oldestMessageTs != null ? { oldestMessageTs: proof.oldestMessageTs } : {}),
    ...(proof.newestMessageTs != null ? { newestMessageTs: proof.newestMessageTs } : {}),
  };
  return Object.keys(coverage).length > 0 ? coverage : undefined;
}
