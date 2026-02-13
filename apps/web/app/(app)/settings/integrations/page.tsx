"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { ArrowLeftIcon, TwitterIcon } from "lucide-react";
import { api } from "@cued/convex";
import {
  IMessageColorIcon,
  SlackColorIcon,
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
    icon: <IMessageColorIcon className="size-5" />,
    integrationType: "electron-local",
    color: "text-green-500",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Connect Slack via desktop app to sync messages",
    icon: <SlackColorIcon className="size-5" />,
    integrationType: "electron-webview",
    color: "text-purple-500",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    description: "Sync LinkedIn messages via desktop app",
    icon: <LinkedInIcon className="size-5" />,
    integrationType: "electron-webview",
    color: "text-blue-600",
  },
  {
    id: "twitter",
    name: "X (Twitter)",
    description: "Sync DMs and contacts via desktop app",
    icon: <TwitterIcon className="size-5" />,
    integrationType: "electron-webview",
    color: "text-sky-500",
  },
];

export default function IntegrationsPage() {
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

    setError("Integration not properly configured");
  }

  async function handleDisconnect(config: IntegrationConfig) {
    // Handle electron-webview disconnects (like Slack)
    if (config.integrationType === "electron-webview") {
      setError(`${config.name} disconnect requires the Cued desktop app. Open the desktop app settings to disconnect.`);
      return;
    }
  }

  async function handleDisconnectAccount(
    _config: IntegrationConfig,
    _workspaceId: string,
    workspaceId: string
  ) {
    setDisconnectingAccount(workspaceId);
    setError("Account disconnect not supported for this platform");
    setDisconnectingAccount(null);
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
                  onDisconnectAccount={(workspaceId) => {
                    const account = status?.accounts?.find(a => a.workspaceId === workspaceId);
                    if (account) {
                      handleDisconnectAccount(config, workspaceId, account.workspaceId);
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
                <strong>Slack:</strong> Use the desktop app to login with your Slack workspace
                (credentials stay local)
              </li>
              <li>
                <strong>LinkedIn:</strong> Use the desktop app to login and scrape your
                connections
              </li>
              <li>
                <strong>X (Twitter):</strong> Use the desktop app to login and sync DMs and
                mutual contacts
              </li>
              <li>Your data is securely synced and never shared</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
