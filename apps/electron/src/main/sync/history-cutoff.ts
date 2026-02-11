import { getSettingsManager } from "../settings";

/**
 * Compute the cutoff timestamp (ms since epoch) based on the syncHistoryDays setting.
 * Messages older than this timestamp should be skipped during initial/full sync.
 */
export function getSyncCutoffMs(): number {
  const days = getSettingsManager().getSyncHistoryDays();
  return Date.now() - days * 24 * 60 * 60 * 1000;
}
