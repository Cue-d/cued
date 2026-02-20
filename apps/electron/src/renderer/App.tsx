import { useState, useCallback, useEffect, useMemo } from "react"
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
import { Toaster } from "sonner"
import { useAuthState, useAutoUpdater, useConvexClient, useLinkedIn, useTwitter, useSlack, useSignal, useElectron } from "./hooks/use-electron"
import { ThemeProvider } from "./hooks/use-theme"
import { AppShell, type NavPage } from "./components/app-shell"
import { FocusProvider } from "./context/FocusContext"
import { ActionsPage } from "./pages/ActionsPage"
import { AssistantPage } from "./pages/AssistantPage"
import { ContactsPage } from "./pages/ContactsPage"
import { SettingsPage, type SettingsSubpage } from "./pages/SettingsPage"
import { PageErrorBoundary } from "./components/PageErrorBoundary"
import { getOrCreateConvexClient } from "./lib/convex-client-singleton"
import { initPostHog, posthog, POSTHOG_KEY } from "./lib/posthog"
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard"
import type { PermissionStatus } from "../shared/electron-api"

const LEGACY_ONBOARDING_COMPLETE_KEY = "cued-onboarding-complete"

function hasRequiredOnboardingPermissions(status: PermissionStatus): boolean {
  return status.fullDiskAccess && status.contacts && status.messagesAutomation
}

/**
 * Auth hook for ConvexProviderWithAuth.
 * Ensures queries only fire after the token is available.
 */
function useElectronConvexAuth() {
  const { getAccessToken } = useConvexClient()
  const auth = useAuthState()

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      const token = await getAccessToken(forceRefreshToken)
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

function UpdateBanner() {
  const { status, quitAndInstall } = useAutoUpdater()

  if (!status || status.status !== "ready") return null

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-primary text-primary-foreground text-sm">
      <span>Update{status.version ? ` v${status.version}` : ""} ready</span>
      <Button size="sm" variant="secondary" onClick={quitAndInstall}>
        Restart
      </Button>
    </div>
  )
}

function AuthenticatedApp({ convexUrl, user, onSignOut }: { convexUrl: string; user?: { id: string; firstName?: string | null; lastName?: string | null; email?: string | null } | null; onSignOut: () => void }) {
  const electron = useElectron()
  const [onboardingComplete, setOnboardingComplete] = useState(false)
  const [onboardingStateLoading, setOnboardingStateLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState<NavPage>("actions")
  const [actionCount, setActionCount] = useState(0)
  const [settingsSubpage, setSettingsSubpage] = useState<SettingsSubpage>('general')
  const [pendingContactId, setPendingContactId] = useState<string | null>(null)
  const convex = useMemo(() => getOrCreateConvexClient(convexUrl), [convexUrl])

  useEffect(() => {
    let cancelled = false

    const loadOnboardingState = async () => {
      try {
        const completed = await electron.settings.getOnboardingCompleted()
        if (completed) {
          try {
            const permissions = await electron.permissions.check()
            if (!hasRequiredOnboardingPermissions(permissions)) {
              console.warn("[Onboarding] Required permissions missing at startup, resetting completion:", permissions)
              await electron.settings.setOnboardingCompleted(false)
              if (!cancelled) setOnboardingComplete(false)
              return
            }
          } catch (error) {
            console.warn("[Onboarding] Failed to validate permissions for completed onboarding state:", error)
          }
          if (!cancelled) setOnboardingComplete(true)
          return
        }

        // One-time migration path from the older renderer-localStorage key.
        const legacyCompleted = localStorage.getItem(LEGACY_ONBOARDING_COMPLETE_KEY) === "true"
        if (legacyCompleted) {
          try {
            await electron.settings.setOnboardingCompleted(true)
            localStorage.removeItem(LEGACY_ONBOARDING_COMPLETE_KEY)
          } catch (error) {
            console.warn("[Onboarding] Failed to migrate onboarding completion state:", error)
          }
        }

        if (!cancelled) setOnboardingComplete(legacyCompleted)
      } catch (error) {
        console.warn("[Onboarding] Failed to load onboarding completion state:", error)
        if (!cancelled) {
          setOnboardingComplete(localStorage.getItem(LEGACY_ONBOARDING_COMPLETE_KEY) === "true")
        }
      } finally {
        if (!cancelled) setOnboardingStateLoading(false)
      }
    }

    void loadOnboardingState()

    return () => {
      cancelled = true
    }
  }, [electron])

  const handleOnboardingComplete = useCallback(async () => {
    try {
      await electron.settings.setOnboardingCompleted(true)
      localStorage.removeItem(LEGACY_ONBOARDING_COMPLETE_KEY)
    } catch (error) {
      console.warn("[Onboarding] Failed to persist onboarding completion state:", error)
      localStorage.setItem(LEGACY_ONBOARDING_COMPLETE_KEY, "true")
    }
    setOnboardingComplete(true)
  }, [electron])

  // Initialize PostHog and identify user
  useEffect(() => {
    initPostHog()
    if (POSTHOG_KEY && user?.id) {
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined
      posthog.identify(user.id, { email: user.email ?? undefined, name })
    }
  }, [user])

  // Track page navigation
  useEffect(() => {
    if (POSTHOG_KEY) {
      posthog.capture("$pageview", { $current_url: `cued-electron:///${currentPage}` })
    }
  }, [currentPage])

  // Integration status hooks
  const { isLoggedIn: linkedInConnected } = useLinkedIn()
  const { isLoggedIn: twitterConnected } = useTwitter()
  const { isConnected: slackConnected } = useSlack()
  const { isLoggedIn: signalConnected } = useSignal()

  // Build connected platforms list
  const connectedPlatforms = useMemo(() => {
    const platforms: ActionPlatform[] = ['imessage'] // iMessage always connected on macOS
    if (linkedInConnected) platforms.push('linkedin')
    if (twitterConnected) platforms.push('twitter')
    if (slackConnected) platforms.push('slack')
    if (signalConnected) platforms.push('signal')
    return platforms
  }, [linkedInConnected, twitterConnected, slackConnected, signalConnected])

  const handleNavigate = useCallback((page: NavPage) => {
    if (page !== 'contacts') setPendingContactId(null)
    setCurrentPage(page)
  }, [])

  const handleNavigateToShortcuts = useCallback(() => {
    setCurrentPage('settings')
    setSettingsSubpage('shortcuts')
  }, [])

  const handleNavigateToIntegrations = useCallback(() => {
    setCurrentPage('settings')
    setSettingsSubpage('integrations')
  }, [])

  const handleNavigateToContact = useCallback((contactId: string) => {
    setPendingContactId(contactId)
    setCurrentPage('contacts')
  }, [])

  const renderPage = () => {
    switch (currentPage) {
      case "actions":
        return <ActionsPage onActionCountChange={setActionCount} onContactClick={handleNavigateToContact} />
      case "assistant":
        return <AssistantPage />
      case "contacts":
        return <ContactsPage initialContactId={pendingContactId} onInitialContactConsumed={() => setPendingContactId(null)} />
      case "settings":
        return <SettingsPage subpage={settingsSubpage} onSubpageChange={setSettingsSubpage} />
      default:
        return <ActionsPage onActionCountChange={setActionCount} onContactClick={handleNavigateToContact} />
    }
  }

  if (onboardingStateLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <Card className="w-full max-w-md" style={{ backgroundColor: 'rgba(30,30,30,0.9)', backdropFilter: 'blur(20px)' }}>
          <CardContent className="p-6">
            <Skeleton className="h-8 w-40 mx-auto mb-4" />
            <Skeleton className="h-4 w-56 mx-auto" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!onboardingComplete) {
    return (
      <ConvexProviderWithAuth client={convex} useAuth={useElectronConvexAuth}>
        <OnboardingWizard user={user} onComplete={handleOnboardingComplete} />
      </ConvexProviderWithAuth>
    )
  }

  return (
    <FocusProvider>
      <ConvexProviderWithAuth client={convex} useAuth={useElectronConvexAuth}>
        <UpdateBanner />
        <AppShell
          currentPage={currentPage}
          onNavigate={handleNavigate}
          onNavigateToShortcuts={handleNavigateToShortcuts}
          onNavigateToIntegrations={handleNavigateToIntegrations}
          onSignOut={() => {
            posthog.reset()
            onSignOut()
          }}
          actionCount={actionCount}
          user={user}
          connectedPlatforms={connectedPlatforms}
          onPlatformClick={handleNavigateToIntegrations}
        >
          <PageErrorBoundary resetKey={currentPage}>
            {renderPage()}
          </PageErrorBoundary>
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
      <Toaster />
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
