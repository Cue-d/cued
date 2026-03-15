import type { PlatformCapabilitySummary } from "../../../core/platform-capabilities.js";
import type { AuthSessionRow, IntegrationStateRow } from "../../../db/database.js";
import type {
  AuthSessionState,
  ConnectionKind,
  IntegrationAuthState,
  IntegrationLaunchStrategy,
  IntegrationRuntimeKind,
  Platform,
} from "../types.js";

export interface IntegrationStateSummary {
  platform: Platform;
  accountKey: string;
  displayName: string | null;
  authState: IntegrationAuthState;
  enabled: boolean;
  connectionKind: ConnectionKind;
  runtimeKind: IntegrationRuntimeKind;
  syncCapable: boolean;
  launchStrategy: IntegrationLaunchStrategy | null;
  launchTarget: string | null;
  importedFrom: string | null;
  artifactPaths: string[];
  metadata: Record<string, unknown> | null;
  lastSeenAt: number;
  updatedAt: number;
  latestAuthSessionId: string | null;
  capability: PlatformCapabilitySummary;
}

export interface AuthSessionSummary {
  id: string;
  platform: Platform;
  accountKey: string;
  integrationStateId: string;
  state: AuthSessionState;
  nativePid: number | null;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  keychainService: string | null;
  keychainAccount: string | null;
  resultSummary: Record<string, unknown> | null;
  errorSummary: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CompletedAuthSessionSummary {
  authSession: AuthSessionSummary | null;
  integration: IntegrationStateSummary | null;
}

export interface ManagedIntegrationState {
  platform: Platform;
  accountKey: string;
  displayName: string;
  authState: IntegrationAuthState;
  enabled: boolean;
  connectionKind: ConnectionKind;
  runtimeKind: IntegrationRuntimeKind;
  syncCapable: boolean;
  launchStrategy?: IntegrationLaunchStrategy | null;
  launchTarget?: string | null;
  importedFrom: string;
  artifactPaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface RequestableIntegrationConfig {
  connectionKind: ConnectionKind;
  runtimeKind: IntegrationRuntimeKind;
  launchStrategy: IntegrationLaunchStrategy;
  launchTarget: string | null;
  displayName: string;
  metadata?: Record<string, unknown>;
}

export interface CompletedAuthSessionInput {
  state: Extract<AuthSessionState, "authenticated" | "failed" | "cancelled">;
  keychainService?: string | null;
  keychainAccount?: string | null;
  resultSummary?: Record<string, unknown> | null;
  errorSummary?: string | null;
}

export type IntegrationRowLike = Pick<IntegrationStateRow, "metadata_json" | "launch_strategy">;
export type AuthSessionRowLike = AuthSessionRow;
