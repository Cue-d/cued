import type {
  ProviderRawEventInput,
  SourceAccountInput,
  SyncMode,
  SyncProofInput,
} from "../../core/types/provider.js";

export type { ProviderRawEventInput as RawEventInput, SourceAccountInput };

export type SyncContinuationReason =
  | "account_pagination"
  | "scoped_proof_continuation"
  | "rate_limit_backoff"
  | "realtime_catchup";

export interface SyncContinuation {
  reason: SyncContinuationReason;
  detail?: string;
  delayMs?: number;
  scope?: {
    kind: string;
    key: string;
    proofKind?: string;
  };
}

export interface SyncBundle {
  sourceAccounts: SourceAccountInput[];
  rawEvents: ProviderRawEventInput[];
  sourceCursor?: unknown;
  syncMode?: SyncMode;
  hasMore?: boolean;
  continuation?: SyncContinuation;
  proofs?: SyncProofInput[];
  diagnostics?: Record<string, unknown>;
}

export interface AdapterWorkerOutput {
  ok: boolean;
  bundle?: SyncBundle;
  error?: string;
}
