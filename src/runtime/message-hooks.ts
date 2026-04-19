import type { ProviderRawEventInput, RawEventAcquisitionMode } from "../core/types/provider.js";

export type MessageReceivedHookMessage = {
  platform: ProviderRawEventInput["platform"];
  accountKey: string;
  observedAt: number;
  acquisitionMode: RawEventAcquisitionMode | null;
  payload: Record<string, unknown>;
};

export type MessageReceivedHookPayload = {
  runId: string;
  message: MessageReceivedHookMessage;
};

export function collectInboundMessageHookPayloads(
  runId: string,
  insertedRows: Array<{ rowId: number; event: ProviderRawEventInput }>,
  isInboundMessageEvent: (event: Record<string, unknown>) => boolean,
): Array<{ rowId: number; payload: MessageReceivedHookPayload }> {
  const inboundMessages: Array<{ rowId: number; payload: MessageReceivedHookPayload }> = [];
  for (const insertedRow of insertedRows) {
    const rawEvent = insertedRow.event;
    if (
      !isInboundMessageEvent({ ...rawEvent, payload: rawEvent.payload as Record<string, unknown> })
    ) {
      continue;
    }

    inboundMessages.push({
      rowId: insertedRow.rowId,
      payload: {
        runId,
        message: {
          platform: rawEvent.platform,
          accountKey: rawEvent.accountKey,
          observedAt: rawEvent.observedAt,
          acquisitionMode: rawEvent.provenance?.acquisitionMode ?? null,
          payload: rawEvent.payload as Record<string, unknown>,
        },
      },
    });
  }

  return inboundMessages;
}
