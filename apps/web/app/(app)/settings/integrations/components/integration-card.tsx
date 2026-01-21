"use client";

import {
  CheckCircle2Icon,
  XCircleIcon,
  RefreshCwIcon,
  LinkIcon,
} from "lucide-react";
import { formatRelativeTime } from "@prm/shared";
import { Button, Skeleton } from "@prm/ui";

export type Platform = "imessage" | "gmail" | "slack" | "linkedin" | "twitter" | "signal" | "whatsapp";

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
  onConnect: () => void;
  onDisconnect: () => void;
}

export function IntegrationButton({
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

  // Connected state - show disconnect for nango and electron-webview types
  if (isConnected) {
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

interface IntegrationCardProps {
  config: IntegrationConfig;
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  isLoading: boolean;
  lastSyncAt: number | null;
  /** Additional text to show when connected (e.g., team name for Slack) */
  connectedDetail?: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function IntegrationCard({
  config,
  isConnected,
  isConnecting,
  isDisconnecting,
  isLoading,
  lastSyncAt,
  connectedDetail,
  onConnect,
  onDisconnect,
}: IntegrationCardProps) {
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

      {isConnected && (lastSyncAt || connectedDetail) && (
        <div className="border-t px-4 py-2 flex items-center gap-3">
          {connectedDetail && (
            <span className="text-xs font-medium">{connectedDetail}</span>
          )}
          {lastSyncAt && (
            <p className="text-xs text-muted-foreground">
              Last synced {formatRelativeTime(lastSyncAt)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
