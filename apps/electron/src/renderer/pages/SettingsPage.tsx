import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@cued/convex"
import {
  Button,
  Badge,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
} from "@cued/ui"
import { Settings, Keyboard, Sun, Moon, Monitor, Plug } from "lucide-react"
import { useTheme, type Theme } from "../hooks/use-theme"
import { usePermissions } from "../hooks/use-permissions"
import { Panel, PanelHeader } from "../components/app-shell"
import { SettingsSection, SettingsCard, SettingsRow } from "../components/settings-card"
import {
  useAuthState,
  useUnifiedSync,
  useLinkedIn,
  useTwitter,
  useSlack,
  useSignal,
  useElectron,
} from "../hooks/use-electron"
import { SignalLoginDialog } from "../components/SignalLoginDialog"
import { cmdKey } from "../lib/platform"

interface SettingsToggleProps {
  label: string
  description?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

function SettingsToggle({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  className,
}: SettingsToggleProps) {
  const id = React.useId()

  return (
    <div className={cn("flex items-center justify-between px-4 py-3.5", disabled && "opacity-50", className)}>
      <label htmlFor={id} className="flex-1 min-w-0 cursor-pointer select-none">
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="text-sm text-muted-foreground mt-0">{description}</div>
        )}
      </label>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="ml-4 shrink-0"
      />
    </div>
  )
}

export type SettingsSubpage = 'general' | 'integrations' | 'shortcuts'

const themeOptions: { value: Theme; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
]

const UNDO_DELAY_OPTIONS = [
  { value: 3, label: "3 seconds" },
  { value: 5, label: "5 seconds" },
  { value: 10, label: "10 seconds" },
  { value: 15, label: "15 seconds" },
  { value: 30, label: "30 seconds" },
] as const

interface SettingsNavItem {
  id: SettingsSubpage
  label: string
  icon: React.ComponentType<{ className?: string }>
  shortcut?: string
}

const settingsNavItems: SettingsNavItem[] = [
  { id: 'general', label: 'General', icon: Settings, shortcut: `${cmdKey},` },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, shortcut: `${cmdKey}/` },
]

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn(
      "inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[11px] font-medium bg-muted border border-border rounded shadow-sm",
      className
    )}>
      {children}
    </kbd>
  )
}

interface ShortcutItem {
  keys: string[]
  description: string
}

interface ShortcutSection {
  title: string
  shortcuts: ShortcutItem[]
}

const shortcutSections: ShortcutSection[] = [
  {
    title: 'Global',
    shortcuts: [
      { keys: [cmdKey, '1'], description: 'Go to Actions' },
      { keys: [cmdKey, '2'], description: 'Go to Assistant' },
      { keys: [cmdKey, '3'], description: 'Go to Contacts' },
      { keys: [cmdKey, '4'], description: 'Go to Settings' },
      { keys: [cmdKey, ','], description: 'Open settings' },
      { keys: [cmdKey, '/'], description: 'Show keyboard shortcuts' },
      { keys: [cmdKey, 'B'], description: 'Toggle sidebar' },
    ],
  },
  {
    title: 'Navigation',
    shortcuts: [
      { keys: ['Tab'], description: 'Move to next zone' },
      { keys: ['⇧', 'Tab'], description: 'Move to previous zone' },
      { keys: ['↑', '↓'], description: 'Navigate items in list' },
      { keys: ['Home'], description: 'Go to first item' },
      { keys: ['End'], description: 'Go to last item' },
      { keys: ['Esc'], description: 'Close dialog / blur input' },
    ],
  },
  {
    title: 'Actions',
    shortcuts: [
      { keys: ['↑', '↓'], description: 'Navigate actions' },
      { keys: ['←'], description: 'Discard action' },
      { keys: ['→'], description: 'Send / complete action' },
      { keys: ['S'], description: 'Snooze action' },
      { keys: ['I'], description: 'Focus response input' },
      { keys: ['F'], description: 'Open filter dropdown' },
    ],
  },
  {
    title: 'Contacts',
    shortcuts: [
      { keys: ['F'], description: 'Open filter dropdown' },
    ],
  },
  {
    title: 'Assistant',
    shortcuts: [
      { keys: ['Enter'], description: 'Send message' },
      { keys: ['⇧', 'Enter'], description: 'New line' },
      { keys: ['Esc'], description: 'Stop generation' },
    ],
  },
]

function ShortcutsContent() {
  return (
    <div className="h-full flex flex-col">
      <PanelHeader title="Shortcuts" />
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto space-y-8">
            {shortcutSections.map((section) => (
              <SettingsSection key={section.title} title={section.title}>
                <SettingsCard>
                  {section.shortcuts.map((shortcut, index) => (
                    <SettingsRow key={index} label={shortcut.description}>
                      <div className="flex items-center gap-1">
                        {shortcut.keys.map((key, keyIndex) => (
                          <Kbd key={keyIndex}>{key}</Kbd>
                        ))}
                      </div>
                    </SettingsRow>
                  ))}
                </SettingsCard>
              </SettingsSection>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

function PermissionRow({
  label,
  description,
  granted,
  isChecking,
  onOpenSettings,
}: {
  label: string
  description: string
  granted: boolean | undefined
  isChecking: boolean
  onOpenSettings: () => void
}) {
  return (
    <SettingsRow label={label} description={description}>
      {isChecking ? (
        <div className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse" />
      ) : granted ? (
        <Badge variant="secondary" className="bg-green-500/10 text-green-500">
          Granted
        </Badge>
      ) : (
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="bg-amber-500/10 text-amber-500">
            Not Granted
          </Badge>
          <Button variant="outline" size="sm" onClick={onOpenSettings}>
            Open Settings
          </Button>
        </div>
      )}
    </SettingsRow>
  )
}

const SYNC_HISTORY_OPTIONS = [
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
  { value: 180, label: "180 days" },
  { value: 365, label: "1 year" },
]

function GeneralContent() {
  const auth = useAuthState()
  const electron = useElectron()
  const { permissions, isChecking } = usePermissions()
  const userSettings = useQuery(api.users.getSettings)
  const updateUndoDelay = useMutation(api.users.updateUndoSendDelay)
  const { theme, setTheme } = useTheme()
  const fullName = [auth.user?.firstName, auth.user?.lastName].filter(Boolean).join(' ')
  const [syncHistoryDays, setSyncHistoryDays] = React.useState<number>(90)

  React.useEffect(() => {
    electron.settings.getSyncHistoryDays().then(setSyncHistoryDays)
  }, [electron])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title="General" />
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* Account */}
              <SettingsSection title="Account" description="Manage your Cued account">
                <SettingsCard>
                  <SettingsRow
                    label={fullName || "User"}
                    description={auth.user?.email}
                  >
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <span className="text-sm font-medium">
                        {auth.user?.firstName?.charAt(0) || "?"}
                      </span>
                    </div>
                  </SettingsRow>
                  <SettingsRow label="Sign out">
                    <Button variant="outline" size="sm" onClick={auth.signOut}>
                      Sign Out
                    </Button>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* Permissions */}
              <SettingsSection title="Permissions" description="Required for syncing iMessage and contacts">
                <SettingsCard>
                  <PermissionRow
                    label="Full Disk Access"
                    description="Required to read iMessage database"
                    granted={permissions?.fullDiskAccess}
                    isChecking={isChecking}
                    onOpenSettings={() => electron.permissions.openFullDiskAccessSettings()}
                  />
                  <PermissionRow
                    label="Contacts"
                    description="Required to sync macOS contacts"
                    granted={permissions?.contacts}
                    isChecking={isChecking}
                    onOpenSettings={() => electron.permissions.openContactsSettings()}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Appearance */}
              <SettingsSection title="Appearance" description="Choose how Cued looks">
                <SettingsCard>
                  <SettingsRow label="Theme">
                    <div className="flex gap-1.5">
                      {themeOptions.map((option) => {
                        const Icon = option.icon
                        const isSelected = theme === option.value
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setTheme(option.value)}
                            className={cn(
                              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors",
                              isSelected
                                ? "bg-foreground/[0.07] font-medium"
                                : "hover:bg-foreground/5 text-muted-foreground"
                            )}
                          >
                            <Icon className="w-4 h-4" />
                            <span>{option.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* Sync History */}
              <SettingsSection title="Sync History" description="How far back to sync messages on initial sync">
                <SettingsCard>
                  <SettingsRow
                    label="History window"
                    description="Applies to iMessage, Slack, LinkedIn, and Twitter"
                  >
                    <Select
                      value={String(syncHistoryDays)}
                      onValueChange={async (value) => {
                        const days = Number(value)
                        setSyncHistoryDays(days)
                        try {
                          const saved = await electron.settings.setSyncHistoryDays(days)
                          setSyncHistoryDays(saved)
                        } catch (e) {
                          console.error("Failed to save sync history days:", e)
                        }
                      }}
                    >
                      <SelectTrigger className="w-[140px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SYNC_HISTORY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={String(option.value)}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* Sending */}
              <SettingsSection title="Sending" description="Control message sending behavior">
                <SettingsCard>
                  <SettingsRow
                    label="Undo send delay"
                    description="How long you have to cancel a message"
                  >
                    <Select
                      value={String(userSettings?.undoSendDelaySeconds ?? 30)}
                      onValueChange={(value) => {
                        updateUndoDelay({ delaySeconds: Number(value) })
                      }}
                    >
                      <SelectTrigger className="w-[140px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {UNDO_DELAY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={String(option.value)}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

function IntegrationsContent({ sync }: { sync: ReturnType<typeof useUnifiedSync> }) {
  const { isLoggedIn: linkedInLoggedIn, isLoading: linkedInLoading, login: linkedInLogin, logout: linkedInLogout } = useLinkedIn()
  const { isLoggedIn: twitterLoggedIn, isLoading: twitterLoading, login: twitterLogin, logout: twitterLogout } = useTwitter()
  const { isConnected: slackConnected, workspaces: slackWorkspaces, isLoading: slackLoading, login: slackLogin, disconnect: slackDisconnect } = useSlack()
  const { isLoggedIn: signalLoggedIn, isLoading: signalLoading, setup: signalSetup, openLinkTerminal: signalOpenLink, checkLink: signalCheckLink, logout: signalLogout } = useSignal()
  const [signalDialogOpen, setSignalDialogOpen] = React.useState(false)
  const electron = useElectron()
  const gmailStatus = useQuery(api.integrations.getIntegrationStatus, { platform: "gmail" })
  const gmailConnected = gmailStatus?.isConnected ?? false
  const gmailLoading = gmailStatus === undefined
  const [appUrl, setAppUrl] = React.useState<string>("https://www.cued.so")

  React.useEffect(() => {
    electron.config.getAppUrl().then(setAppUrl)
  }, [electron])

  const totalMessages =
    (sync.progress.platforms.imessage?.messages ?? 0) +
    (sync.progress.platforms.linkedin?.messages ?? 0) +
    (sync.progress.platforms.twitter?.messages ?? 0) +
    (sync.progress.platforms.signal?.messages ?? 0) +
    (sync.progress.platforms.slack?.messages ?? 0)

  const totalContacts =
    (sync.progress.platforms.contacts?.synced ?? 0) +
    (sync.progress.platforms.linkedin?.contacts ?? 0) +
    (sync.progress.platforms.twitter?.contacts ?? 0) +
    (sync.progress.platforms.signal?.contacts ?? 0)

  const isSyncing = sync.progress.status === "syncing"

  async function handleSlackLogin(): Promise<void> {
    const result = await slackLogin()
    if (!result.success && result.error) {
      console.error("Slack login failed:", result.error)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title="Integrations" />
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* Sync Status */}
              <SettingsSection title="Sync Status" description={isSyncing ? `Syncing ${sync.progress.currentPlatform || ''}...` : 'All data synced'}>
                <SettingsCard>
                  <SettingsRow label="Messages" description={`${totalMessages.toLocaleString()} synced`}>
                    {isSyncing && <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
                  </SettingsRow>
                  <SettingsRow label="Contacts" description={`${totalContacts.toLocaleString()} synced`}>
                    {isSyncing && <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
                  </SettingsRow>
                  {sync.progress.lastSyncAt && (
                    <SettingsRow label="Last sync" description={new Date(sync.progress.lastSyncAt).toLocaleTimeString()} />
                  )}
                  <SettingsRow label="Manual sync">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={sync.runNow}
                      disabled={isSyncing}
                    >
                      {isSyncing ? "Syncing..." : "Sync Now"}
                    </Button>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* LinkedIn */}
              <SettingsSection title="LinkedIn" description={linkedInLoading ? "Checking..." : linkedInLoggedIn ? "Connected" : "Not connected"}>
                <SettingsCard>
                  <SettingsRow
                    label="Connection"
                    description={linkedInLoggedIn ? "Contacts and messages will sync automatically" : "Connect to sync LinkedIn contacts and messages"}
                  >
                    {linkedInLoggedIn && (
                      <Badge variant="secondary" className="bg-green-500/10 text-green-500 mr-2">
                        Connected
                      </Badge>
                    )}
                    <Button variant="outline" size="sm" onClick={linkedInLoggedIn ? linkedInLogout : linkedInLogin}>
                      {linkedInLoggedIn ? "Disconnect" : "Connect"}
                    </Button>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* Slack */}
              <SettingsSection
                title="Slack"
                description={
                  slackLoading ? "Checking..." :
                  slackConnected ? `${slackWorkspaces.length} workspace${slackWorkspaces.length > 1 ? "s" : ""} connected` :
                  "Not connected"
                }
              >
                <SettingsCard>
                  {slackWorkspaces.length > 0 && slackWorkspaces.map((workspace) => (
                    <SettingsRow
                      key={workspace.teamId}
                      label={workspace.teamName}
                      description="Connected workspace"
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => slackDisconnect(workspace.teamId)}
                      >
                        Disconnect
                      </Button>
                    </SettingsRow>
                  ))}
                  <SettingsRow
                    label={slackConnected ? "Add workspace" : "Connect Slack"}
                    description={slackConnected ? "Connect another Slack workspace" : "Connect to sync Slack messages"}
                  >
                    <Button variant="outline" size="sm" onClick={handleSlackLogin}>
                      {slackConnected ? "Add" : "Connect"}
                    </Button>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* Twitter/X */}
              <SettingsSection title="Twitter / X" description={twitterLoading ? "Checking..." : twitterLoggedIn ? "Connected" : "Not connected"}>
                <SettingsCard>
                  <SettingsRow
                    label="Connection"
                    description={twitterLoggedIn ? "Messages and contacts will sync automatically" : "Connect to sync Twitter/X messages and contacts"}
                  >
                    {twitterLoggedIn && (
                      <Badge variant="secondary" className="bg-green-500/10 text-green-500 mr-2">
                        Connected
                      </Badge>
                    )}
                    <Button variant="outline" size="sm" onClick={twitterLoggedIn ? twitterLogout : twitterLogin}>
                      {twitterLoggedIn ? "Disconnect" : "Connect"}
                    </Button>
                  </SettingsRow>
                  {twitterLoggedIn && (
                    <>
                      <SettingsRow label="Messages" description={`${(sync.progress.platforms.twitter?.messages ?? 0).toLocaleString()} synced`}>
                        {isSyncing && sync.progress.currentPlatform === "twitter" && <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
                      </SettingsRow>
                      <SettingsRow label="Contacts" description={`${(sync.progress.platforms.twitter?.contacts ?? 0).toLocaleString()} synced`}>
                        {isSyncing && sync.progress.currentPlatform === "twitter_contacts" && <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
                      </SettingsRow>
                    </>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* Signal */}
              <SettingsSection title="Signal" description={signalLoading ? "Checking..." : signalLoggedIn ? "Connected" : "Not connected"}>
                <SettingsCard>
                  <SettingsRow
                    label="Connection"
                    description={signalLoggedIn ? "Messages will sync automatically" : "Connect to sync Signal messages"}
                  >
                    {signalLoggedIn && (
                      <Badge variant="secondary" className="bg-green-500/10 text-green-500 mr-2">
                        Connected
                      </Badge>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={signalLoggedIn ? signalLogout : () => setSignalDialogOpen(true)}
                    >
                      {signalLoggedIn ? "Disconnect" : "Connect"}
                    </Button>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              <SignalLoginDialog
                open={signalDialogOpen}
                onOpenChange={setSignalDialogOpen}
                onSuccess={() => {}}
                setup={signalSetup}
                openLinkTerminal={signalOpenLink}
                checkLink={signalCheckLink}
              />

              {/* Gmail */}
              <SettingsSection title="Gmail" description={gmailLoading ? "Checking..." : gmailConnected ? "Connected" : "Not connected"}>
                <SettingsCard>
                  <SettingsRow
                    label="Connection"
                    description={gmailConnected ? "Emails will sync automatically" : "Connect via web app to sync Gmail"}
                  >
                    {gmailConnected && (
                      <Badge variant="secondary" className="bg-green-500/10 text-green-500 mr-2">
                        Connected
                      </Badge>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => electron.shell.openExternal(`${appUrl}/settings/integrations`)}
                    >
                      {gmailConnected ? "Manage" : "Connect"}
                    </Button>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

interface SettingsPageProps {
  subpage?: SettingsSubpage
  onSubpageChange?: (subpage: SettingsSubpage) => void
}

function SettingsDetailContent({ subpage, sync }: { subpage: SettingsSubpage; sync: ReturnType<typeof useUnifiedSync> }): React.JSX.Element {
  switch (subpage) {
    case 'shortcuts':
      return <ShortcutsContent />
    case 'integrations':
      return <IntegrationsContent sync={sync} />
    case 'general':
    default:
      return <GeneralContent />
  }
}

export function SettingsPage({ subpage = 'general', onSubpageChange }: SettingsPageProps): React.JSX.Element {
  const sync = useUnifiedSync()
  const [activeSubpage, setActiveSubpage] = React.useState<SettingsSubpage>(subpage)

  React.useEffect(() => {
    setActiveSubpage(subpage)
  }, [subpage])

  function handleSubpageChange(newSubpage: SettingsSubpage): void {
    setActiveSubpage(newSubpage)
    onSubpageChange?.(newSubpage)
  }

  return (
    <>
      <Panel variant="shrink" width={320} position="first">
        <PanelHeader title="Settings" />
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {settingsNavItems.map((item) => {
            const Icon = item.icon
            const isSelected = activeSubpage === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSubpageChange(item.id)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
                  isSelected
                    ? "bg-foreground/[0.07] font-medium"
                    : "hover:bg-foreground/5 text-muted-foreground"
                )}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">{item.label}</span>
                {item.shortcut && (
                  <span className="text-xs text-muted-foreground">{item.shortcut}</span>
                )}
              </button>
            )
          })}
        </div>
      </Panel>

      <Panel position="last">
        <SettingsDetailContent subpage={activeSubpage} sync={sync} />
      </Panel>
    </>
  )
}
