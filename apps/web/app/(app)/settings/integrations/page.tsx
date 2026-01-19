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
  CheckCircle2Icon,
  XCircleIcon,
  ArrowLeftIcon,
  RefreshCwIcon,
  LinkIcon,
  LinkedinIcon,
  TwitterIcon,
  ExternalLinkIcon,
  UsersIcon,
} from "lucide-react";
import { api } from "@prm/convex";
import { Button, Skeleton, Input } from "@prm/ui";

type Platform = "imessage" | "gmail" | "slack" | "linkedin" | "twitter";

interface IntegrationConfig {
  id: Platform;
  name: string;
  description: string;
  icon: React.ReactNode;
  nangoIntegrationId: string | null; // null = not using Nango (iMessage uses Electron)
  color: string;
}

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

interface SocialIntegrationConfig {
  id: "linkedin" | "twitter";
  name: string;
  description: string;
  icon: React.ReactNode;
  color: string;
}

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

interface IntegrationCardProps {
  config: IntegrationConfig;
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  isLoading: boolean;
  lastSyncAt: number | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

function IntegrationCard({
  config,
  isConnected,
  isConnecting,
  isDisconnecting,
  isLoading,
  lastSyncAt,
  onConnect,
  onDisconnect,
}: IntegrationCardProps) {
  function renderStatusAndAction() {
    if (isLoading) {
      return <Skeleton className="h-9 w-24" />;
    }

    if (isConnected) {
      return (
        <>
          <div className="flex items-center gap-1.5 text-green-600">
            <CheckCircle2Icon className="size-4" />
            <span className="text-xs font-medium">Connected</span>
          </div>
          {config.nangoIntegrationId && (
            <Button variant="outline" size="sm" onClick={onDisconnect} disabled={isDisconnecting}>
              {isDisconnecting ? <RefreshCwIcon className="size-4 animate-spin" /> : "Disconnect"}
            </Button>
          )}
        </>
      );
    }

    return (
      <>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <XCircleIcon className="size-4" />
          <span className="text-xs">Not connected</span>
        </div>
        {config.nangoIntegrationId ? (
          <Button variant="default" size="sm" onClick={onConnect} disabled={isConnecting}>
            {isConnecting ? (
              <RefreshCwIcon className="size-4 animate-spin mr-2" />
            ) : (
              <LinkIcon className="size-4 mr-2" />
            )}
            Connect
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Desktop App Required
          </Button>
        )}
      </>
    );
  }

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
        <div className="flex items-center gap-3">{renderStatusAndAction()}</div>
      </div>

      {isConnected && lastSyncAt && (
        <div className="border-t px-4 py-2">
          <p className="text-xs text-muted-foreground">
            Last synced {formatRelativeTime(lastSyncAt)}
          </p>
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Task 8.8: Social Integration Card for LinkedIn/Twitter
interface SocialIntegrationCardProps {
  config: SocialIntegrationConfig;
  isConnected: boolean;
  isLoading: boolean;
  lastSyncAt: number | null;
  totalContactsSynced: number;
}

function SocialIntegrationCard({
  config,
  isConnected,
  isLoading,
  lastSyncAt,
  totalContactsSynced,
}: SocialIntegrationCardProps) {
  const [twitterUsername, setTwitterUsername] = useState("");

  function renderStatusAndAction() {
    if (isLoading) {
      return <Skeleton className="h-9 w-24" />;
    }

    if (isConnected) {
      return (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-green-600">
            <CheckCircle2Icon className="size-4" />
            <span className="text-xs font-medium">Logged In</span>
          </div>
          <Button variant="outline" size="sm" disabled>
            <RefreshCwIcon className="size-4 mr-2" />
            Scrape Now
          </Button>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <XCircleIcon className="size-4" />
          <span className="text-xs">Not logged in</span>
        </div>
        <Button variant="outline" size="sm" disabled>
          <ExternalLinkIcon className="size-4 mr-2" />
          Open Login
        </Button>
      </div>
    );
  }

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
        <div className="flex items-center gap-3">{renderStatusAndAction()}</div>
      </div>

      {/* Twitter username input */}
      {config.id === "twitter" && (
        <div className="border-t px-4 py-3">
          <label className="text-xs text-muted-foreground block mb-1.5">
            Username to scrape mutuals for
          </label>
          <Input
            placeholder="@username"
            value={twitterUsername}
            onChange={(e) => setTwitterUsername(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
      )}

      {/* Stats section */}
      {(isConnected || totalContactsSynced > 0) && (
        <div className="border-t px-4 py-2 flex items-center gap-4">
          {totalContactsSynced > 0 && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <UsersIcon className="size-3.5" />
              <span className="text-xs">{totalContactsSynced} connections</span>
            </div>
          )}
          {lastSyncAt && (
            <span className="text-xs text-muted-foreground">
              Last scraped {formatRelativeTime(lastSyncAt)}
            </span>
          )}
        </div>
      )}

      {/* Desktop app required notice */}
      <div className="border-t px-4 py-2 bg-muted/30">
        <p className="text-xs text-muted-foreground">
          💡 Requires the PRM desktop app to scrape social connections
        </p>
      </div>
    </div>
  );
}
