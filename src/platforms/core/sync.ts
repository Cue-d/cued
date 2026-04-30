import type {
  ProviderRawEventInput,
  SourceAccountInput,
  SyncMode,
  SyncProofInput,
} from "../../core/types/provider.js";

export type { ProviderRawEventInput as RawEventInput, SourceAccountInput };

export interface SyncBundle {
  sourceAccounts: SourceAccountInput[];
  rawEvents: ProviderRawEventInput[];
  sourceCursor?: unknown;
  syncMode?: SyncMode;
  hasMore?: boolean;
  proofs?: SyncProofInput[];
  diagnostics?: Record<string, unknown>;
}

export interface AdapterWorkerOutput {
  ok: boolean;
  bundle?: SyncBundle;
  error?: string;
}
