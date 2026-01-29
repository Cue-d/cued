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
  useUnifiedSync,
  useLinkedIn,
  useSlack,
  type UnifiedSyncProgress,
} from "./hooks/use-electron";

export function App() {
  const auth = useAuthState();
  const sync = useUnifiedSync();

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

            {/* Unified Sync Status */}
            <SyncStatus progress={sync.progress} onSyncNow={sync.runNow} />

            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                disabled={sync.isSyncing}
                onClick={sync.runNow}
              >
                {sync.isSyncing ? "Syncing..." : "Sync Now"}
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
                Connected Platforms
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
  onSyncNow,
}: {
  progress: UnifiedSyncProgress;
  onSyncNow: () => Promise<unknown>;
}) {
  const [syncRate, setSyncRate] = useState<number | null>(null);
  const syncStartRef = useRef<{ time: number; messages: number } | null>(null);

  const totalMessages =
    (progress.platforms.imessage?.messages ?? 0) +
    (progress.platforms.linkedin?.messages ?? 0) +
    (progress.platforms.slack?.messages ?? 0);

  const totalContacts =
    (progress.platforms.contacts?.synced ?? 0) +
    (progress.platforms.linkedin?.contacts ?? 0);

  useEffect(() => {
    if (progress.status === "syncing") {
      if (!syncStartRef.current) {
        syncStartRef.current = {
          time: Date.now(),
          messages: totalMessages,
        };
      }

      const elapsed = (Date.now() - syncStartRef.current.time) / 1000;
      const messagesSynced = totalMessages - syncStartRef.current.messages;
      const rate = elapsed > 0 ? Math.round(messagesSynced / elapsed) : 0;
      if (rate > 0) setSyncRate(rate);
    } else {
      syncStartRef.current = null;
      setSyncRate(null);
    }
  }, [progress, totalMessages]);

  const statusMap: Record<UnifiedSyncProgress["status"], string> = {
    idle: "Idle",
    syncing: "Syncing...",
    error: "Error",
  };

  const statusIcon: Record<UnifiedSyncProgress["status"], string> = {
    idle: "✓",
    syncing: "↻",
    error: "✗",
  };

  const platformLabel = progress.currentPlatform
    ? ` (${progress.currentPlatform})`
    : "";

  const isSyncing = progress.status === "syncing";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          Sync Status
        </p>
        <div className="flex items-center gap-1.5 text-xs">
          <span className={isSyncing ? "animate-spin" : ""}>{statusIcon[progress.status]}</span>
          <span>{statusMap[progress.status]}{platformLabel}</span>
          {syncRate !== null && (
            <span className="text-green-500 font-medium ml-1">
              {syncRate.toLocaleString()} msg/s
            </span>
          )}
        </div>
      </div>

      {/* Messages Progress */}
      <Progress value={isSyncing ? null : 100}>
        <div className="flex justify-between w-full text-xs mb-1">
          <span>Messages</span>
          <span className="text-muted-foreground">
            {totalMessages.toLocaleString()}
          </span>
        </div>
        <ProgressTrack className="h-1.5">
          <ProgressIndicator className={isSyncing ? "animate-pulse" : ""} />
        </ProgressTrack>
      </Progress>

      {/* Contacts Progress */}
      <Progress value={isSyncing ? null : 100}>
        <div className="flex justify-between w-full text-xs mb-1">
          <span>Contacts</span>
          <span className="text-muted-foreground">
            {totalContacts.toLocaleString()}
          </span>
        </div>
        <ProgressTrack className="h-1.5">
          <ProgressIndicator className={isSyncing ? "animate-pulse" : ""} />
        </ProgressTrack>
      </Progress>

      {/* Platform breakdown */}
      <div className="text-xs text-muted-foreground space-y-0.5">
        {progress.platforms.imessage && (
          <p>iMessage: {progress.platforms.imessage.messages.toLocaleString()} messages</p>
        )}
        {progress.platforms.linkedin && (
          <p>
            LinkedIn: {progress.platforms.linkedin.contacts.toLocaleString()} contacts,{" "}
            {progress.platforms.linkedin.messages.toLocaleString()} messages
          </p>
        )}
        {progress.platforms.slack && (
          <p>
            Slack: {progress.platforms.slack.messages.toLocaleString()} messages from{" "}
            {progress.platforms.slack.workspaces} workspace(s)
          </p>
        )}
        {progress.lastSyncAt && (
          <p>Last sync: {new Date(progress.lastSyncAt).toLocaleTimeString()}</p>
        )}
        {progress.error && (
          <p className="text-destructive">Error: {progress.error}</p>
        )}
      </div>
    </div>
  );
}

function LinkedInCard() {
  const { isLoggedIn, isLoading, login, logout } = useLinkedIn();

  return (
    <div className="bg-muted/50 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🔗</span>
          <div>
            <p className="font-semibold text-sm">LinkedIn</p>
            <p className="text-xs text-muted-foreground">
              {isLoading
                ? "Checking..."
                : isLoggedIn
                  ? "✓ Connected"
                  : "Not connected"}
            </p>
          </div>
        </div>
        <div className="flex gap-1">
          {isLoggedIn ? (
            <Button
              variant="secondary"
              size="sm"
              className="text-xs px-2 py-1 h-auto"
              onClick={logout}
            >
              Disconnect
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="text-xs px-2 py-1 h-auto"
              onClick={login}
            >
              Connect
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {isLoggedIn
          ? "Contacts and messages will sync automatically"
          : "Connect to sync LinkedIn contacts and messages"}
      </p>
    </div>
  );
}

function SlackCard() {
  const { isConnected, workspaces, isLoading, login, disconnect } = useSlack();

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
            {isConnected ? "Add Workspace" : "Connect"}
          </Button>
        </div>
      </div>

      {/* Connected Workspaces List */}
      {workspaces.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Workspaces
            </p>
            {workspaces.map((workspace) => (
              <div
                key={workspace.teamId}
                className="bg-background/50 rounded p-2 flex items-center justify-between"
              >
                <p className="text-sm font-medium">{workspace.teamName}</p>
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
            ))}
          </div>
        </>
      )}

      <p className="text-xs text-muted-foreground">
        {isConnected
          ? "Messages will sync automatically"
          : "Connect to sync Slack messages"}
      </p>
    </div>
  );
}
