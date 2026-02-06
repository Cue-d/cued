"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import Nango from "@nangohq/frontend";
import { useAccessToken } from "@workos-inc/authkit-nextjs/components";
import { useQuery } from "convex/react";
import { ArrowLeftIcon } from "lucide-react";
import { api } from "@cued/convex";
import {
  IMessageIcon,
  GmailColorIcon,
  SlackIcon,
  LinkedInIcon,
} from "@cued/ui";
import {
  IntegrationCard,
  type IntegrationAccount,
  type IntegrationConfig,
  type Platform,
} from "./components";

const INTEGRATIONS: IntegrationConfig[] = [
  {
    id: "imessage",
    name: "iMessage",
    description: "Sync messages from macOS Messages app",
    icon: <IMessageIcon className="size-5" />,
    nangoIntegrationId: null,
    integrationType: "electron-local",
    color: "text-green-500",
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Connect your Gmail account to sync emails",
    icon: <GmailColorIcon className="size-5" />,
    nangoIntegrationId: "google",
    integrationType: "nango",
    color: "text-red-500",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Connect Slack via desktop app to sync messages",
    icon: <SlackIcon className="size-5" />,
    nangoIntegrationId: null,
    integrationType: "electron-webview",
    color: "text-purple-500",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    description: "Sync LinkedIn messages via desktop app",
    icon: <LinkedInIcon className="size-5" />,
    nangoIntegrationId: null,
    integrationType: "electron-webview",
    color: "text-blue-600",
  },
];

export default function IntegrationsPage() {
  const { accessToken } = useAccessToken();
  const integrations = useQuery(api.integrations.getUserIntegrations);
  const [connecting, setConnecting] = useState<Platform | null>(null);
  const [disconnecting, setDisconnecting] = useState<Platform | null>(null);
  const [disconnectingAccount, setDisconnectingAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusByPlatform = useMemo(() => {
    const map = new Map<
      Platform,
      {
        isConnected: boolean;
        lastSyncAt: number | null;
        nangoConnectionId: string | null;
        accounts: IntegrationAccount[] | null;
      }
    >();
    for (const int of integrations?.integrations ?? []) {
      const existing = map.get(int.platform);
      const newAccounts = int.accounts ?? [];
      // Dedupe accounts by workspaceId (backend attaches full list to each integration)
      const existingIds = new Set((existing?.accounts ?? []).map((a) => a.workspaceId));
      const uniqueNewAccounts = newAccounts.filter((a) => !existingIds.has(a.workspaceId));
      const mergedAccounts = [...(existing?.accounts ?? []), ...uniqueNewAccounts];
      map.set(int.platform, {
        // Aggregate: connected if ANY integration for this platform is connected
        isConnected: (existing?.isConnected ?? false) || int.isConnected,
        // Take most recent sync time
        lastSyncAt: Math.max(existing?.lastSyncAt ?? 0, int.lastSyncAt ?? 0) || null,
        // Keep first non-null connection ID
        nangoConnectionId: existing?.nangoConnectionId ?? int.nangoConnectionId,
        // Deduplicated accounts
        accounts: mergedAccounts.length > 0 ? mergedAccounts : null,
      });
    }
    return map;
  }, [integrations]);

  async function handleConnect(config: IntegrationConfig) {
    // Handle electron-webview integrations (like Slack)
    if (config.integrationType === "electron-webview") {
      setError(`${config.name} connection requires the Cued desktop app. Open the desktop app and click Connect.`);
      return;
    }

    // Handle electron-local integrations (like iMessage)
    if (config.integrationType === "electron-local") {
      setError(`${config.name} sync requires the Cued desktop app to be running.`);
      return;
    }

    // Handle Nango OAuth integrations
    if (!config.nangoIntegrationId) {
      setError("Integration not properly configured");
      return;
    }
    if (!accessToken) {
      setError("Not authenticated");
      return;
    }

    setConnecting(config.id);
    setError(null);

    try {
      const res = await fetch("/api/nango/session", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ allowed_integrations: [config.nangoIntegrationId] }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create session");
      }

      const { sessionToken } = await res.json();
      const nango = new Nango();
      const connect = nango.openConnectUI({
        onEvent: (event) => {
          if (event.type === "close" || event.type === "connect") {
            setConnecting(null);
          }
        },
      });
      connect.setSessionToken(sessionToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
      setConnecting(null);
    }
  }

  async function handleDisconnect(config: IntegrationConfig) {
    // Handle electron-webview disconnects (like Slack)
    if (config.integrationType === "electron-webview") {
      setError(`${config.name} disconnect requires the Cued desktop app. Open the desktop app settings to disconnect.`);
      return;
    }

    // Nango disconnect
    if (!config.nangoIntegrationId || !accessToken) return;

    const status = statusByPlatform.get(config.id);
    if (!status?.nangoConnectionId) {
      setError("No connection ID found");
      return;
    }

    setDisconnecting(config.id);
    setError(null);

    try {
      const res = await fetch("/api/nango/disconnect", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          nangoConnectionId: status.nangoConnectionId,
          providerConfigKey: config.nangoIntegrationId,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to disconnect");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setDisconnecting(null);
    }
  }

  async function handleDisconnectAccount(
    config: IntegrationConfig,
    nangoConnectionId: string,
    workspaceId: string
  ) {
    if (!config.nangoIntegrationId || !accessToken) return;

    setDisconnectingAccount(workspaceId);
    setError(null);

    try {
      const res = await fetch("/api/nango/disconnect", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          nangoConnectionId,
          providerConfigKey: config.nangoIntegrationId,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to disconnect");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setDisconnectingAccount(null);
    }
  }

  const isLoading = integrations === undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b px-6">
        <Link
          href="/settings"
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon className="size-4" />
          <span className="text-sm">Settings</span>
        </Link>
        <div className="h-4 w-px bg-border" />
        <h1 className="text-lg font-semibold">Integrations</h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 p-6">
          <p className="text-sm text-muted-foreground">
            Connect your messaging platforms to sync conversations and contacts into Cued.
          </p>

          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <div className="space-y-4">
            {INTEGRATIONS.map((config) => {
              const status = statusByPlatform.get(config.id);
              return (
                <IntegrationCard
                  key={config.id}
                  config={config}
                  isConnected={status?.isConnected ?? false}
                  isConnecting={connecting === config.id}
                  isDisconnecting={disconnecting === config.id}
                  disconnectingAccount={disconnectingAccount}
                  isLoading={isLoading}
                  lastSyncAt={status?.lastSyncAt ?? null}
                  accounts={status?.accounts}
                  onConnect={() => handleConnect(config)}
                  onDisconnect={() => handleDisconnect(config)}
                  onDisconnectAccount={(nangoConnectionId) => {
                    const account = status?.accounts?.find(a => a.nangoConnectionId === nangoConnectionId);
                    if (account) {
                      handleDisconnectAccount(config, nangoConnectionId, account.workspaceId);
                    }
                  }}
                />
              );
            })}
          </div>

          <div className="rounded-lg border bg-muted/30 p-4">
            <h3 className="text-sm font-medium mb-2">How it works</h3>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>
                <strong>iMessage:</strong> Install the Cued desktop app on your Mac to sync
                messages locally
              </li>
              <li>
                <strong>Gmail:</strong> Click Connect to authorize Cued to read your emails
              </li>
              <li>
                <strong>Slack:</strong> Use the desktop app to login with your Slack workspace
                (credentials stay local)
              </li>
              <li>
                <strong>LinkedIn:</strong> Use the desktop app to login and scrape your
                connections
              </li>
              <li>Your data is securely synced and never shared</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
