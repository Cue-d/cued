import type { ProviderRawEventInput, SourceAccountInput, SyncMode } from "../types/provider.js";

export type { ProviderRawEventInput as RawEventInput, SourceAccountInput };

export interface SyncBundle {
  sourceAccounts: SourceAccountInput[];
  rawEvents: ProviderRawEventInput[];
  sourceCursor?: unknown;
  syncMode?: SyncMode;
  hasMore?: boolean;
}

export interface AdapterWorkerOutput {
  ok: boolean;
  bundle?: SyncBundle;
  error?: string;
}
