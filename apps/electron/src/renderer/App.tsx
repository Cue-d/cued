import { useState, useRef, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Progress,
  ProgressTrack,
  ProgressIndicator,
  Separator,
  Skeleton,
} from "@prm/ui";
import {
  useAuthState,
  useSyncProgress,
  useLinkedIn,
  useSlack,
  useElectron,
  type SyncProgress,
  type LinkedInSyncProgress,
} from "./hooks/use-electron";
export function App() {
  const auth = useAuthState();
  const { progress, forceSync } = useSyncProgress();

  // Loading state
  if (auth.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <Card className="w-full max-w-md bg-background/60 backdrop-blur-xl">
          <CardContent className="p-6">
            <Skeleton className="h-8 w-32 mx-auto mb-4" />
            <Skeleton className="h-4 w-48 mx-auto" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // Device code display
  if (auth.userCode) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <Card className="w-full max-w-md bg-background/60 backdrop-blur-xl">
          <CardHeader className="text-center">
            <CardTitle>Enter this code</CardTitle>
            <CardDescription>
              A browser window should have opened automatically
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <div className="font-mono text-4xl font-bold tracking-widest py-4">
              {auth.userCode}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Login screen
  if (!auth.isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
          <Card className="w-full max-w-md bg-background/60 backdrop-blur-xl">
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center justify-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-destructive" />
                <span className="text-sm">Not signed in</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Sign in to sync your iMessages with PRM
              </p>
              <Button onClick={auth.login} className="w-full">
                Sign In
              </Button>
            </CardContent>
          </Card>
        </div>
    );
  }

  // Authenticated view
  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="w-full max-w-md space-y-4">
        {/* Auth Card */}
        <Card className="bg-background/60 backdrop-blur-xl">
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
              <span className="text-sm">Signed in</span>
            </div>
            <div className="text-center">
              <p className="font-semibold text-lg">
                {auth.user?.name || "User"}
              </p>
              <p className="text-sm text-muted-foreground">{auth.user?.email}</p>
            </div>

            <Separator />

            {/* Sync Status */}
            <SyncStatus progress={progress} onForceSync={forceSync} />

            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={async () => {
                  if (
                    confirm(
                      "This will re-sync all messages and contacts from your Mac. Continue?"
                    )
                  ) {
                    await forceSync();
                  }
                }}
              >
                Force Full Sync
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={auth.signOut}
              >
                Sign Out
              </Button>
            </div>

            <Separator />

            {/* Social Networks */}
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Social Networks
              </p>
              <LinkedInCard />
              <SlackCard />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SyncStatus({
  progress,
  onForceSync,
}: {
  progress: SyncProgress;
  onForceSync: () => Promise<SyncProgress>;
}) {
  const [syncRate, setSyncRate] = useState<number | null>(null);
  const syncStartRef = useRef<{ time: number; messages: number } | null>(null);

  useEffect(() => {
    if (progress.status === "syncing" || progress.status === "recovery") {
      if (!syncStartRef.current) {
        syncStartRef.current = {
          time: Date.now(),
          messages: progress.totalMessagesSynced,
        };
      }

      const elapsed = (Date.now() - syncStartRef.current.time) / 1000;
      const messagesSynced =
        progress.totalMessagesSynced - syncStartRef.current.messages;
      const rate = elapsed > 0 ? Math.round(messagesSynced / elapsed) : 0;
      if (rate > 0) setSyncRate(rate);
    } else {
      syncStartRef.current = null;
      setSyncRate(null);
    }
  }, [progress]);

  const statusMap: Record<SyncProgress["status"], string> = {
    idle: "Idle",
    syncing: "Syncing...",
    error: "Error",
    recovery: "Recovery in progress...",
  };

  const statusIcon: Record<SyncProgress["status"], string> = {
    idle: "✓",
    syncing: "↻",
    error: "✗",
    recovery: "↻",
  };

  const progressPercent =
    progress.currentBatch &&
    progress.currentBatch.batchNumber +
      progress.currentBatch.estimatedBatchesRemaining >
      0
      ? Math.round(
          (progress.currentBatch.batchNumber /
            (progress.currentBatch.batchNumber +
              progress.currentBatch.estimatedBatchesRemaining)) *
            100
        )
      : 0;

  const isSyncing =
    progress.status === "syncing" || progress.status === "recovery";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          Sync Status
        </p>
        <div className="flex items-center gap-1.5 text-xs">
          <span>{statusIcon[progress.status]}</span>
          <span>{statusMap[progress.status]}</span>
          {syncRate !== null && (
            <span className="text-green-500 font-medium ml-1">
              {syncRate.toLocaleString()} msg/s
            </span>
          )}
        </div>
      </div>

      {/* Messages Progress */}
      <Progress value={isSyncing ? progressPercent || null : 100}>
        <div className="flex justify-between w-full text-xs mb-1">
          <span>Messages</span>
          <span className="text-muted-foreground">
            {progress.totalMessagesSynced.toLocaleString()}
          </span>
        </div>
        <ProgressTrack className="h-1.5">
          <ProgressIndicator
            className={isSyncing && !progressPercent ? "animate-pulse" : ""}
          />
        </ProgressTrack>
      </Progress>

      {/* Contacts Progress */}
      <Progress value={isSyncing ? null : 100}>
        <div className="flex justify-between w-full text-xs mb-1">
          <span>Contacts</span>
          <span className="text-muted-foreground">
            {(progress.totalContactsSynced ?? 0).toLocaleString()}
          </span>
        </div>
        <ProgressTrack className="h-1.5">
          <ProgressIndicator className={isSyncing ? "animate-pulse" : ""} />
        </ProgressTrack>
      </Progress>

      {/* Additional info */}
      {(progress.recoveryReason || progress.error || progress.lastSyncAt) && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {progress.recoveryReason && (
            <p>Recovery: {progress.recoveryReason}</p>
          )}
          {progress.lastSyncAt && (
            <p>
              Last sync: {new Date(progress.lastSyncAt).toLocaleTimeString()}
            </p>
          )}
          {progress.error && (
            <p className="text-destructive">Error: {progress.error}</p>
          )}
        </div>
      )}
    </div>
  );
}

function formatLinkedInSyncStatus(progress: LinkedInSyncProgress | null): string {
  if (!progress) return "Not syncing";

  switch (progress.status) {
    case "realtime":
      return "⚡ Realtime connected";
    case "syncing":
      return "↻ Syncing...";
    case "error":
      return `✗ Error: ${progress.error ?? "Unknown error"}`;
    default:
      return progress.lastSyncAt
        ? `Last sync: ${new Date(progress.lastSyncAt).toLocaleTimeString()}`
        : "Not syncing";
  }
}

function LinkedInCard() {
  const { isLoggedIn, isLoading, syncProgress, login, startSync, stopSync, scrape } =
    useLinkedIn();
  const [scrapeProgress, setScrapeProgress] = useState<string | null>(null);
  const electron = useElectron();

  useEffect(() => {
    const unsub = electron.sync.linkedin.onScrapeProgress((progress) => {
      if (progress.status === "starting") {
        setScrapeProgress("Scraping...");
      } else if (progress.status === "complete") {
        setScrapeProgress(`✓ Scraped ${progress.count} connections`);
      } else if (progress.status === "error") {
        setScrapeProgress(`Error: ${progress.error}`);
      }
    });
    return unsub;
  }, [electron]);

  const isSyncing = syncProgress?.status === "syncing";

  return (
    <div className="bg-muted/50 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🔗</span>
          <div>
            <p className="font-semibold text-sm">LinkedIn</p>
            <p className="text-xs text-muted-foreground">
              {isLoading
                ? "Checking..."
                : isLoggedIn
                  ? "✓ Logged in"
                  : "Not logged in"}
            </p>
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            variant="secondary"
            size="sm"
            className="text-xs px-2 py-1 h-auto"
            onClick={login}
          >
            Login
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="text-xs px-2 py-1 h-auto"
            disabled={!isLoggedIn}
            onClick={() => scrape()}
          >
            Scrape
          </Button>
        </div>
      </div>

      {scrapeProgress && (
        <p className="text-xs text-muted-foreground">{scrapeProgress}</p>
      )}

      <Separator />

      {/* Messaging Sync */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm">Messaging Sync</p>
          <p className="text-xs text-muted-foreground">
            {formatLinkedInSyncStatus(syncProgress)}
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            variant="secondary"
            size="sm"
            className="text-xs px-2 py-1 h-auto"
            disabled={!isLoggedIn || isSyncing}
            onClick={startSync}
          >
            Start
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="text-xs px-2 py-1 h-auto"
            disabled={!isSyncing}
            onClick={stopSync}
          >
            Stop
          </Button>
        </div>
      </div>

      {/* LinkedIn Messages Progress */}
      {syncProgress && (syncProgress.totalMessagesSynced > 0 || isSyncing) && (
        <Progress value={isSyncing ? null : 100}>
          <div className="flex justify-between w-full text-xs mb-1">
            <span>Messages</span>
            <span className="text-muted-foreground">
              {syncProgress.totalConversationsSynced} convos ·{" "}
              {syncProgress.totalMessagesSynced} msgs
                          </span>
          </div>
          <ProgressTrack className="h-1.5">
            <ProgressIndicator className={isSyncing ? "animate-pulse" : ""} />
          </ProgressTrack>
        </Progress>
      )}
    </div>
  );
}

type SyncProgressStatus = {
  status?: "idle" | "syncing" | "realtime" | "error";
  lastSyncAt?: number;
  error?: string;
};

function formatSyncStatus(progress: SyncProgressStatus | undefined): string {
  if (!progress) return "Ready";

  switch (progress.status) {
    case "realtime":
      return "⚡ Realtime";
    case "syncing":
      return "↻ Syncing...";
    case "error":
      return `✗ ${progress.error ?? "Unknown error"}`;
    default:
      return progress.lastSyncAt
        ? `Synced ${new Date(progress.lastSyncAt).toLocaleTimeString()}`
        : "Ready";
  }
}

function SlackCard() {
  const { isConnected, workspaces, isLoading, syncProgress, login, disconnect, startSync, stopSync } =
    useSlack();

  const isSyncing = syncProgress?.status === "syncing";

  const handleLogin = async () => {
    const result = await login();
    if (!result.success && result.error) {
      console.error("Slack login failed:", result.error);
    }
  };

  return (
    <div className="bg-muted/50 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">#</span>
          <div>
            <p className="font-semibold text-sm">Slack</p>
            <p className="text-xs text-muted-foreground">
              {isLoading
                ? "Checking..."
                : isConnected
                  ? `✓ ${workspaces.length} workspace${workspaces.length > 1 ? "s" : ""} connected`
                  : "Not connected"}
            </p>
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            variant="secondary"
            size="sm"
            className="text-xs px-2 py-1 h-auto"
            onClick={handleLogin}
          >
            {isConnected ? "Add Workspace" : "Login"}
          </Button>
        </div>
      </div>

      {/* Connected Workspaces List */}
      {workspaces.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Connected Workspaces
            </p>
            {workspaces.map((workspace) => {
              const wsProgress = workspace.syncProgress;
              const wsIsSyncing = wsProgress?.status === "syncing";

              return (
                <div
                  key={workspace.teamId}
                  className="bg-background/50 rounded p-2 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{workspace.teamName}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatSyncStatus(wsProgress)}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs px-2 py-1 h-auto"
                        disabled={wsIsSyncing}
                        onClick={() => startSync(workspace.teamId)}
                        title="Start sync"
                      >
                        ▶
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs px-2 py-1 h-auto"
                        disabled={!wsIsSyncing}
                        onClick={() => stopSync(workspace.teamId)}
                        title="Stop sync"
                      >
                        ⏹
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs px-2 py-1 h-auto text-destructive hover:text-destructive"
                        onClick={() => disconnect(workspace.teamId)}
                        title="Disconnect"
                      >
                        ✕
                      </Button>
                    </div>
                  </div>

                  {/* Workspace-specific progress */}
                  {wsProgress && (wsProgress.totalMessagesSynced > 0 || wsIsSyncing) && (
                    <div className="text-xs text-muted-foreground">
                      {wsProgress.totalConversationsSynced} convos · {wsProgress.totalMessagesSynced} msgs
                                          </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Global Sync Controls (when connected) */}
      {isConnected && workspaces.length > 1 && (
        <>
          <Separator />
          <div className="flex items-center justify-between">
            <p className="text-sm">All Workspaces</p>
            <div className="flex gap-1">
              <Button
                variant="secondary"
                size="sm"
                className="text-xs px-2 py-1 h-auto"
                disabled={isSyncing}
                onClick={() => startSync()}
              >
                Start All
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="text-xs px-2 py-1 h-auto"
                disabled={!isSyncing}
                onClick={() => stopSync()}
              >
                Stop All
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Aggregated Messages Progress */}
      {syncProgress && (syncProgress.totalMessagesSynced > 0 || isSyncing) && workspaces.length === 1 && (
        <Progress value={isSyncing ? null : 100}>
          <div className="flex justify-between w-full text-xs mb-1">
            <span>Messages</span>
            <span className="text-muted-foreground">
              {syncProgress.totalConversationsSynced} convos ·{" "}
              {syncProgress.totalMessagesSynced} msgs
                          </span>
          </div>
          <ProgressTrack className="h-1.5">
            <ProgressIndicator className={isSyncing ? "animate-pulse" : ""} />
          </ProgressTrack>
        </Progress>
      )}
    </div>
  );
}
