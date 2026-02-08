import { useState, useCallback, useMemo } from "react"
import { ConvexProviderWithAuth } from "convex/react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Skeleton,
} from "@cued/ui"
import { type ActionPlatform } from "@cued/shared"
import { useAuthState, useConvexClient, useLinkedIn, useSlack, useSignal } from "./hooks/use-electron"
import { ThemeProvider } from "./hooks/use-theme"
import { AppShell, type NavPage } from "./components/app-shell"
import { FocusProvider } from "./context/FocusContext"
import { ActionsPage } from "./pages/ActionsPage"
import { AssistantPage } from "./pages/AssistantPage"
import { ContactsPage } from "./pages/ContactsPage"
import { SettingsPage, type SettingsSubpage } from "./pages/SettingsPage"
import { getOrCreateConvexClient } from "./lib/convex-client-singleton"

/**
 * Auth hook for ConvexProviderWithAuth.
 * Ensures queries only fire after the token is available.
 */
function useElectronConvexAuth() {
  const { getAccessToken } = useConvexClient()
  const auth = useAuthState()

  const fetchAccessToken = useCallback(
    async (_opts: { forceRefreshToken: boolean }) => {
      // Electron's getAccessToken always returns a fresh token via
      // getValidAccessToken() in the main process, so forceRefreshToken
      // is inherently handled.
      const token = await getAccessToken()
      return token ?? null
    },
    [getAccessToken]
  )

  return {
    isLoading: auth.isLoading,
    isAuthenticated: auth.isAuthenticated,
    fetchAccessToken,
  }
}

function AuthenticatedApp({ convexUrl, user, onSignOut }: { convexUrl: string; user?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null; onSignOut: () => void }) {
  const [currentPage, setCurrentPage] = useState<NavPage>("actions")
  const [actionCount, setActionCount] = useState(0)
  const [settingsSubpage, setSettingsSubpage] = useState<SettingsSubpage>('general')
  const convex = useMemo(() => getOrCreateConvexClient(convexUrl), [convexUrl])

  // Integration status hooks
  const { isLoggedIn: linkedInConnected } = useLinkedIn()
  const { isConnected: slackConnected } = useSlack()
  const { isLoggedIn: signalConnected } = useSignal()

  // Build connected platforms list
  const connectedPlatforms = useMemo(() => {
    const platforms: ActionPlatform[] = ['imessage'] // iMessage always connected on macOS
    if (linkedInConnected) platforms.push('linkedin')
    if (slackConnected) platforms.push('slack')
    if (signalConnected) platforms.push('signal')
    return platforms
  }, [linkedInConnected, slackConnected, signalConnected])

  const handleNavigate = useCallback((page: NavPage) => setCurrentPage(page), [])

  const handleNavigateToShortcuts = useCallback(() => {
    setCurrentPage('settings')
    setSettingsSubpage('shortcuts')
  }, [])

  const handleNavigateToIntegrations = useCallback(() => {
    setCurrentPage('settings')
    setSettingsSubpage('integrations')
  }, [])

  const renderPage = () => {
    switch (currentPage) {
      case "actions":
        return <ActionsPage onActionCountChange={setActionCount} />
      case "assistant":
        return <AssistantPage />
      case "contacts":
        return <ContactsPage />
      case "settings":
        return <SettingsPage subpage={settingsSubpage} onSubpageChange={setSettingsSubpage} />
      default:
        return <ActionsPage onActionCountChange={setActionCount} />
    }
  }

  return (
    <FocusProvider>
      <ConvexProviderWithAuth client={convex} useAuth={useElectronConvexAuth}>
        <AppShell
          currentPage={currentPage}
          onNavigate={handleNavigate}
          onNavigateToShortcuts={handleNavigateToShortcuts}
          onNavigateToIntegrations={handleNavigateToIntegrations}
          onSignOut={onSignOut}
          actionCount={actionCount}
          user={user}
          connectedPlatforms={connectedPlatforms}
          onPlatformClick={handleNavigateToIntegrations}
        >
          {renderPage()}
        </AppShell>
      </ConvexProviderWithAuth>
    </FocusProvider>
  )
}

export function App() {
  // Check if electron API is available
  if (!window.electron) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8" style={{ backgroundColor: '#1a1a1a' }}>
        <div className="w-full max-w-md p-6 rounded-lg" style={{ backgroundColor: '#2a2a2a', color: '#fff' }}>
          <h2 className="text-lg font-semibold mb-2">Electron API Not Available</h2>
          <p className="text-sm opacity-70">
            The preload script may have failed to load. Check the console for errors.
          </p>
        </div>
      </div>
    )
  }

  return (
    <ThemeProvider>
      <AppWithElectron />
    </ThemeProvider>
  )
}

function AppWithElectron() {
  const auth = useAuthState()
  const { convexUrl, isLoading: convexLoading } = useConvexClient()

  // Loading state
  if (auth.isLoading || convexLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <Card className="w-full max-w-md" style={{ backgroundColor: 'rgba(30,30,30,0.9)', backdropFilter: 'blur(20px)' }}>
          <CardContent className="p-6">
            <Skeleton className="h-8 w-32 mx-auto mb-4" />
            <Skeleton className="h-4 w-48 mx-auto" />
          </CardContent>
        </Card>
      </div>
    )
  }

  // Device code display
  if (auth.userCode) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <Card className="w-full max-w-md" style={{ backgroundColor: 'rgba(30,30,30,0.9)', backdropFilter: 'blur(20px)' }}>
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
    )
  }

  // Login screen
  if (!auth.isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <Card className="w-full max-w-md" style={{ backgroundColor: 'rgba(30,30,30,0.9)', backdropFilter: 'blur(20px)' }}>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#ef4444' }} />
              <span className="text-sm">Not signed in</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Sign in to sync your iMessages with Cued
            </p>
            <Button onClick={auth.login} className="w-full">
              Sign In
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Authenticated view - need convex URL
  if (!convexUrl) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <Card className="w-full max-w-md" style={{ backgroundColor: 'rgba(30,30,30,0.9)', backdropFilter: 'blur(20px)' }}>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground text-center">
              Loading...
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <AuthenticatedApp convexUrl={convexUrl} user={auth.user} onSignOut={auth.signOut} />
}
