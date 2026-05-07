import { randomUUID } from "node:crypto";
import { safeParseJson } from "../db/codecs.js";
import type { ActionEffectRow, ActionRow, ContactMemoryRow } from "../db/database.js";

export interface ActionSkillDatabase {
  addContactMemory(input: {
    contactId: string;
    body: string;
    sourceKind?: string;
    evidence?: unknown;
    confidence?: number | null;
    supersedesMemoryId?: string | null;
    createdBy?: string | null;
  }): ContactMemoryRow;
  markContactMemoryStale(id: string, staleAt?: number | null): ContactMemoryRow | null;
  moveContactMemoriesToContact(input: {
    fromContactId: string;
    toContactId: string;
    updatedAt?: number;
  }): void;
  contactExists(id: string): boolean;
  conversationExists(id: string): boolean;
  recordActionEffect(input: {
    actionId: string;
    effectType: string;
    targetTable?: string | null;
    targetId?: string | null;
    payload?: unknown;
    appliedAt?: number;
  }): ActionEffectRow;
  listActiveActionEffects(input?: {
    actionType?: string;
    effectType?: string;
    limit?: number;
  }): ActionEffectRow[];
}

export interface ActionExecutionContext {
  action: ActionRow;
  db: ActionSkillDatabase;
  executedBy: string;
  helpers: ActionExecutionHelpers;
}

export interface ActionExecutionResult {
  result: unknown;
  effects: ActionEffectRow[];
}

export type ActionExecutor = (context: ActionExecutionContext) => ActionExecutionResult;

export interface ActionExecutionHelpers {
  randomUUID: typeof randomUUID;
  parseActionPayloadObject: typeof parseActionPayloadObject;
  requiredStringPayload: typeof requiredStringPayload;
  optionalStringPayload: typeof optionalStringPayload;
  optionalNumberPayload: typeof optionalNumberPayload;
  optionalObjectPayload: typeof optionalObjectPayload;
}

export const actionExecutionHelpers: ActionExecutionHelpers = {
  randomUUID,
  parseActionPayloadObject,
  requiredStringPayload,
  optionalStringPayload,
  optionalNumberPayload,
  optionalObjectPayload,
};

export function parseActionPayloadObject(action: ActionRow): Record<string, unknown> {
  const payload = safeParseJson<Record<string, unknown> | null>(
    action.payload_json,
    `action:${action.id}:payload`,
    null,
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  if (!payload) {
    throw new Error(`Action payload must be a JSON object: ${action.id}`);
  }
  return payload;
}

export function requiredStringPayload(
  payload: Record<string, unknown>,
  field: string,
  action: ActionRow,
): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Action '${action.action_type}' payload field '${field}' must be a string.`);
  }
  return value;
}

export function optionalStringPayload(
  payload: Record<string, unknown>,
  field: string,
  action: ActionRow,
): string | null {
  const value = payload[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Action '${action.action_type}' payload field '${field}' must be a string.`);
  }
  return value;
}

export function optionalNumberPayload(
  payload: Record<string, unknown>,
  field: string,
  action: ActionRow,
): number | null {
  const value = payload[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Action '${action.action_type}' payload field '${field}' must be a number.`);
  }
  return value;
}

export function optionalObjectPayload(
  payload: Record<string, unknown>,
  field: string,
  action: ActionRow,
): Record<string, unknown> | null {
  const value = payload[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Action '${action.action_type}' payload field '${field}' must be an object.`);
  }
  return value as Record<string, unknown>;
}
