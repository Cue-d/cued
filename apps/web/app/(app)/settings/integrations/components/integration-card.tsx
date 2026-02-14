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

/** Type alias for ActionPlatform for convenience */
export type Platform = ActionPlatform;

/** Type of integration connection method */
export type IntegrationType = "electron-local" | "electron-webview";

export interface IntegrationConfig {
  id: ActionPlatform;
  name: string;
  description: string;
  icon: React.ReactNode;
  /** How this integration connects: electron-local (auto-sync), electron-webview (login required) */
  integrationType: IntegrationType;
  color: string;
}

interface ConnectionStatusProps {
  isConnected: boolean;
  isLoading: boolean;
}

function ConnectionStatus({ isConnected, isLoading }: ConnectionStatusProps) {
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
  onConnect: () => void;
  onDisconnect: () => void;
}

function IntegrationButton({
  isConnected,
  isConnecting,
  isDisconnecting,
  isLoading,
  integrationType,
  onConnect,
  onDisconnect,
}: IntegrationButtonProps) {
  if (isLoading) {
    return <Skeleton className="h-9 w-24" />;
  }

  // Connected state - show disconnect for electron-webview types
  if (isConnected) {
    if (integrationType === "electron-webview") {
      return (
        <Button variant="outline" size="sm" onClick={onDisconnect} disabled={isDisconnecting}>
          {isDisconnecting ? <RefreshCwIcon className="size-4 animate-spin" /> : "Disconnect"}
        </Button>
      );
    }
    // electron-local (iMessage) - no disconnect button, just shows status
    return null;
  }

  // Not connected state - electron-local (iMessage) requires desktop app
  if (integrationType === "electron-local") {
    return (
      <Button variant="outline" size="sm" disabled>
        Desktop App Required
      </Button>
    );
  }

  // electron-webview - show connect button
  const connectLabel = integrationType === "electron-webview" ? "Connect via Desktop" : "Connect";
  const ConnectIcon = isConnecting ? RefreshCwIcon : LinkIcon;

  return (
    <Button variant="default" size="sm" onClick={onConnect} disabled={isConnecting}>
      <ConnectIcon className={`size-4 mr-2 ${isConnecting ? "animate-spin" : ""}`} />
      {connectLabel}
    </Button>
  );
}

export interface IntegrationAccount {
  workspaceId: string;
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
  /** Connected accounts for multi-workspace platforms (Slack) */
  accounts?: IntegrationAccount[] | null;
  onConnect: () => void;
  onDisconnect: () => void;
  /** Disconnect a specific account by its workspaceId */
  onDisconnectAccount?: (workspaceId: string) => void;
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
                <span className="text-muted-foreground">
                  {account.lastSyncAt
                    ? `Synced ${formatRelativeTime(account.lastSyncAt)}`
                    : "Not synced"}
                </span>
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
