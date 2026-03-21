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
