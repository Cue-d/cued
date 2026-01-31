"use client";

import {
  CheckCircle2Icon,
  XCircleIcon,
  RefreshCwIcon,
  LinkIcon,
  XIcon,
} from "lucide-react";
import { formatRelativeTime, type ActionPlatform } from "@cued/shared";
import { Button, Skeleton } from "@cued/ui";

// Re-export Platform type from @cued/shared for convenience
export type Platform = ActionPlatform;

/** Type of integration connection method */
export type IntegrationType = "nango" | "electron-local" | "electron-webview";

export interface IntegrationConfig {
  id: Platform;
  name: string;
  description: string;
  icon: React.ReactNode;
  /** Nango integration ID for OAuth integrations, null for Electron-based */
  nangoIntegrationId: string | null;
  /** How this integration connects: nango (OAuth), electron-local (auto-sync), electron-webview (login required) */
  integrationType: IntegrationType;
  color: string;
}

interface ConnectionStatusProps {
  isConnected: boolean;
  isLoading: boolean;
}

export function ConnectionStatus({ isConnected, isLoading }: ConnectionStatusProps) {
  if (isLoading) {
    return <Skeleton className="h-4 w-20" />;
  }

  if (isConnected) {
    return (
      <div className="flex items-center gap-1.5 text-green-600">
        <CheckCircle2Icon className="size-4" />
        <span className="text-xs font-medium">Connected</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-muted-foreground">
      <XCircleIcon className="size-4" />
      <span className="text-xs">Not connected</span>
    </div>
  );
}

interface IntegrationButtonProps {
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  isLoading: boolean;
  integrationType: IntegrationType;
  /** When true, per-account disconnect buttons are available, hide main disconnect */
  hasPerAccountDisconnect?: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function IntegrationButton({
  isConnected,
  isConnecting,
  isDisconnecting,
  isLoading,
  integrationType,
  hasPerAccountDisconnect,
  onConnect,
  onDisconnect,
}: IntegrationButtonProps) {
  if (isLoading) {
    return <Skeleton className="h-9 w-24" />;
  }

  // Connected state - show disconnect for nango and electron-webview types
  if (isConnected) {
    // For nango integrations with per-account disconnect, show "Add Account" instead
    if (integrationType === "nango" && hasPerAccountDisconnect) {
      return (
        <Button variant="outline" size="sm" onClick={onConnect} disabled={isConnecting}>
          {isConnecting ? (
            <RefreshCwIcon className="size-4 animate-spin mr-2" />
          ) : (
            <LinkIcon className="size-4 mr-2" />
          )}
          Add Account
        </Button>
      );
    }
    if (integrationType === "nango" || integrationType === "electron-webview") {
      return (
        <Button variant="outline" size="sm" onClick={onDisconnect} disabled={isDisconnecting}>
          {isDisconnecting ? <RefreshCwIcon className="size-4 animate-spin" /> : "Disconnect"}
        </Button>
      );
    }
    // electron-local (iMessage) - no disconnect button, just shows status
    return null;
  }

  // Not connected state
  if (integrationType === "nango") {
    return (
      <Button variant="default" size="sm" onClick={onConnect} disabled={isConnecting}>
        {isConnecting ? (
          <RefreshCwIcon className="size-4 animate-spin mr-2" />
        ) : (
          <LinkIcon className="size-4 mr-2" />
        )}
        Connect
      </Button>
    );
  }

  if (integrationType === "electron-webview") {
    return (
      <Button variant="default" size="sm" onClick={onConnect} disabled={isConnecting}>
        {isConnecting ? (
          <RefreshCwIcon className="size-4 animate-spin mr-2" />
        ) : (
          <LinkIcon className="size-4 mr-2" />
        )}
        Connect via Desktop
      </Button>
    );
  }

  // electron-local (iMessage)
  return (
    <Button variant="outline" size="sm" disabled>
      Desktop App Required
    </Button>
  );
}

export interface IntegrationAccount {
  workspaceId: string;
  nangoConnectionId: string | null;
  lastSyncAt: number | null;
  totalMessagesSynced: number;
}

interface IntegrationCardProps {
  config: IntegrationConfig;
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  /** Account currently being disconnected (by workspaceId) */
  disconnectingAccount?: string | null;
  isLoading: boolean;
  lastSyncAt: number | null;
  /** Connected accounts for multi-workspace platforms (Gmail, Slack) */
  accounts?: IntegrationAccount[] | null;
  onConnect: () => void;
  onDisconnect: () => void;
  /** Disconnect a specific account by its nangoConnectionId */
  onDisconnectAccount?: (nangoConnectionId: string) => void;
}

export function IntegrationCard({
  config,
  isConnected,
  isConnecting,
  isDisconnecting,
  disconnectingAccount,
  isLoading,
  lastSyncAt,
  accounts,
  onConnect,
  onDisconnect,
  onDisconnectAccount,
}: IntegrationCardProps) {
  const hasAccounts = accounts && accounts.length > 0;
  // Check if any account has per-account disconnect capability (has nangoConnectionId)
  const hasPerAccountDisconnect = accounts?.some((a) => a.nangoConnectionId) ?? false;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-4">
          <div
            className={`flex size-12 items-center justify-center rounded-lg bg-muted ${config.color}`}
          >
            {config.icon}
          </div>
          <div>
            <h3 className="text-sm font-medium">{config.name}</h3>
            <p className="text-xs text-muted-foreground">{config.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionStatus isConnected={isConnected} isLoading={isLoading} />
          <IntegrationButton
            isConnected={isConnected}
            isConnecting={isConnecting}
            isDisconnecting={isDisconnecting}
            isLoading={isLoading}
            integrationType={config.integrationType}
            hasPerAccountDisconnect={hasPerAccountDisconnect}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
        </div>
      </div>

      {/* Show connected accounts for multi-workspace platforms */}
      {isConnected && hasAccounts && (
        <div className="border-t px-4 py-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Connected accounts</p>
          {accounts.map((account) => {
            const isAccountDisconnecting = disconnectingAccount === account.workspaceId;
            return (
              <div
                key={account.workspaceId}
                className="flex items-center justify-between text-xs gap-2"
              >
                <span className="font-medium truncate max-w-[200px]">{account.workspaceId}</span>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    {account.lastSyncAt
                      ? `Synced ${formatRelativeTime(account.lastSyncAt)}`
                      : "Not synced"}
                  </span>
                  {account.nangoConnectionId && onDisconnectAccount && (
                    <button
                      onClick={() => onDisconnectAccount(account.nangoConnectionId!)}
                      disabled={isAccountDisconnecting}
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                      title="Disconnect account"
                    >
                      {isAccountDisconnecting ? (
                        <RefreshCwIcon className="size-3.5 animate-spin" />
                      ) : (
                        <XIcon className="size-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Fallback: show single lastSyncAt for non-multi-workspace platforms */}
      {isConnected && !hasAccounts && lastSyncAt && (
        <div className="border-t px-4 py-2 flex items-center gap-3">
          <p className="text-xs text-muted-foreground">
            Last synced {formatRelativeTime(lastSyncAt)}
          </p>
        </div>
      )}
    </div>
  );
}
