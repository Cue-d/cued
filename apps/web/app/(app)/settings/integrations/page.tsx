"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import Nango from "@nangohq/frontend";
import { useAccessToken } from "@workos-inc/authkit-nextjs/components";
import { useQuery } from "convex/react";
import {
  MessageCircleIcon,
  MailIcon,
  HashIcon,
  ArrowLeftIcon,
  LinkedinIcon,
  TwitterIcon,
} from "lucide-react";
import { api } from "@prm/convex";
import {
  IntegrationCard,
  SocialIntegrationCard,
  type IntegrationConfig,
  type SocialIntegrationConfig,
  type Platform,
} from "./components";

const INTEGRATIONS: IntegrationConfig[] = [
  {
    id: "imessage",
    name: "iMessage",
    description: "Sync messages from macOS Messages app",
    icon: <MessageCircleIcon className="size-5" />,
    nangoIntegrationId: null, // Uses Electron app
    color: "text-green-500",
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Connect your Gmail account to sync emails",
    icon: <MailIcon className="size-5" />,
    nangoIntegrationId: "google",
    color: "text-red-500",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Connect Slack to sync direct messages",
    icon: <HashIcon className="size-5" />,
    nangoIntegrationId: "slack",
    color: "text-purple-500",
  },
];

const SOCIAL_INTEGRATIONS: SocialIntegrationConfig[] = [
  {
    id: "linkedin",
    name: "LinkedIn",
    description: "Scrape your LinkedIn connections",
    icon: <LinkedinIcon className="size-5" />,
    color: "text-blue-600",
  },
  {
    id: "twitter",
    name: "X (Twitter)",
    description: "Scrape mutual followers from X",
    icon: <TwitterIcon className="size-5" />,
    color: "text-sky-500",
  },
];

export default function IntegrationsPage() {
  const { accessToken } = useAccessToken();
  const integrations = useQuery(api.integrations.getUserIntegrations);
  const [connecting, setConnecting] = useState<Platform | null>(null);
  const [disconnecting, setDisconnecting] = useState<Platform | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusByPlatform = useMemo(() => {
    const map = new Map<
      Platform,
      { isConnected: boolean; lastSyncAt: number | null; nangoConnectionId: string | null }
    >();
    for (const int of integrations?.integrations ?? []) {
      map.set(int.platform, {
        isConnected: int.isConnected,
        lastSyncAt: int.lastSyncAt,
        nangoConnectionId: int.nangoConnectionId,
      });
    }
    return map;
  }, [integrations]);

  async function handleConnect(config: IntegrationConfig) {
    if (!config.nangoIntegrationId) {
      setError("iMessage sync requires the PRM desktop app");
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
            Connect your messaging platforms to sync conversations and contacts into PRM.
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
                  isLoading={isLoading}
                  lastSyncAt={status?.lastSyncAt ?? null}
                  onConnect={() => handleConnect(config)}
                  onDisconnect={() => handleDisconnect(config)}
                />
              );
            })}
          </div>

          {/* Social Network Scrapers Section */}
          <div className="pt-4">
            <h2 className="text-sm font-medium text-muted-foreground mb-4">Social Networks</h2>
            <div className="space-y-4">
              {SOCIAL_INTEGRATIONS.map((config) => {
                const status = statusByPlatform.get(config.id);
                return (
                  <SocialIntegrationCard
                    key={config.id}
                    config={config}
                    isConnected={status?.isConnected ?? false}
                    isLoading={isLoading}
                    lastSyncAt={status?.lastSyncAt ?? null}
                    totalContactsSynced={
                      integrations?.integrations.find((i) => i.platform === config.id)
                        ?.totalMessagesSynced ?? 0
                    }
                  />
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border bg-muted/30 p-4">
            <h3 className="text-sm font-medium mb-2">How it works</h3>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>
                <strong>iMessage:</strong> Install the PRM desktop app on your Mac to sync
                messages locally
              </li>
              <li>
                <strong>Gmail/Slack:</strong> Click Connect to authorize PRM to read your
                messages
              </li>
              <li>
                <strong>LinkedIn/X:</strong> Use the desktop app to login and scrape your
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
