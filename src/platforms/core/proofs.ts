import type { AdapterPlatform, Platform, SyncProofInput } from "../../core/types/provider.js";

export interface SyncProofKindContract {
  platform: AdapterPlatform;
  proofKind: string;
  scopeKind: string;
  completeMeans: string;
  invalidatedBy: string;
  resumeCursorMeans: string;
}

const PROOF_KIND_CONTRACTS: SyncProofKindContract[] = [
  {
    platform: "discord",
    proofKind: "discovery",
    scopeKind: "account",
    completeMeans: "All currently visible direct-message channels were listed for the account.",
    invalidatedBy: "A later account discovery run observes a different channel set.",
    resumeCursorMeans: "Discovery is account-scoped today and does not use a cursor.",
  },
  {
    platform: "discord",
    proofKind: "discovery",
    scopeKind: "conversation",
    completeMeans: "The direct-message conversation was observed during account discovery.",
    invalidatedBy: "A later account discovery run no longer observes the conversation.",
    resumeCursorMeans:
      "No cursor when complete; coverage carries the latest known message edge for the conversation.",
  },
  {
    platform: "discord",
    proofKind: "latest_messages",
    scopeKind: "conversation",
    completeMeans: "The current newest known message edge for the conversation was checked.",
    invalidatedBy: "The provider reports a newer latest message for the conversation.",
    resumeCursorMeans:
      "No cursor when complete; running cursors carry the latest edge still being checked.",
  },
  {
    platform: "discord",
    proofKind: "messages",
    scopeKind: "conversation",
    completeMeans:
      "Historical direct-message pages for the conversation were walked to exhaustion.",
    invalidatedBy:
      "The provider exposes older messages not covered by the stored oldest message id.",
    resumeCursorMeans: "The message id to request before when resuming historical backfill.",
  },
  {
    platform: "gmail",
    proofKind: "messages",
    scopeKind: "account",
    completeMeans:
      "All non-spam, non-trash Gmail messages reachable by the current historical or incremental page walk were fetched.",
    invalidatedBy: "A later Gmail history id or historical page token remains unprocessed.",
    resumeCursorMeans:
      "The Gmail page token/history id state needed to continue the current account walk.",
  },
  {
    platform: "linkedin",
    proofKind: "discovery",
    scopeKind: "account",
    completeMeans: "The LinkedIn conversation discovery scan reached the provider end.",
    invalidatedBy: "A later sync starts a new discovery scan or resumes an incomplete scan.",
    resumeCursorMeans:
      "The LinkedIn conversation-list cursor and scan counters for account discovery.",
  },
  {
    platform: "linkedin",
    proofKind: "messages",
    scopeKind: "conversation",
    completeMeans: "The selected LinkedIn conversation's message pages reached the provider end.",
    invalidatedBy:
      "A later sync observes a newer or older uncovered message range for the conversation.",
    resumeCursorMeans: "The LinkedIn message cursor and delivered-at range for that conversation.",
  },
  {
    platform: "slack",
    proofKind: "messages",
    scopeKind: "conversation",
    completeMeans:
      "Slack channel history for the conversation completed or moved past the history phase.",
    invalidatedBy: "A later Slack history scan observes an uncovered message range.",
    resumeCursorMeans:
      "The Slack history cursor and conversation phase for resuming channel history.",
  },
  {
    platform: "slack",
    proofKind: "replies",
    scopeKind: "conversation",
    completeMeans: "Slack thread replies for known roots in the conversation completed.",
    invalidatedBy: "A later Slack scan observes pending thread roots or an active replies cursor.",
    resumeCursorMeans: "The active thread timestamp, replies cursor, and conversation phase.",
  },
  {
    platform: "signal",
    proofKind: "messages",
    scopeKind: "account",
    completeMeans: "Signal message history for the local account reached the selected sync cursor.",
    invalidatedBy: "A later Signal sync observes additional message history for the account.",
    resumeCursorMeans: "The Signal account-level message cursor needed to continue sync.",
  },
  {
    platform: "whatsapp",
    proofKind: "messages",
    scopeKind: "account",
    completeMeans:
      "WhatsApp helper resync pages for the account completed for the selected since cursor.",
    invalidatedBy: "A later helper resync reports additional pages or a newer message range.",
    resumeCursorMeans: "The WhatsApp helper resync cursor and selected since timestamp.",
  },
];

export function listSyncProofKindContracts(platform?: AdapterPlatform): SyncProofKindContract[] {
  return PROOF_KIND_CONTRACTS.filter((contract) => !platform || contract.platform === platform);
}

export function getSyncProofKindContract(
  platform: Platform,
  proof: Pick<SyncProofInput, "proofKind" | "scope">,
): SyncProofKindContract | null {
  return (
    PROOF_KIND_CONTRACTS.find(
      (contract) =>
        contract.platform === platform &&
        contract.proofKind === proof.proofKind &&
        contract.scopeKind === proof.scope.kind,
    ) ?? null
  );
}

export function assertKnownSyncProofKindContract(platform: Platform, proof: SyncProofInput): void {
  if (getSyncProofKindContract(platform, proof)) {
    return;
  }
  throw new Error(`No sync proof contract for ${platform}:${proof.scope.kind}:${proof.proofKind}`);
}
