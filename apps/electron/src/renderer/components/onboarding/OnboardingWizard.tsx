import { useState } from "react"
import { Button, Badge } from "@cued/ui"
import { HardDrive, Users, Check, X } from "lucide-react"
import { useElectron } from "../../hooks/use-electron"
import { usePermissions } from "../../hooks/use-permissions"
import { StepFormLayout, ContinueButton } from "./primitives"

type OnboardingStep = "welcome" | "fda" | "contacts" | "complete"

interface OnboardingWizardProps {
  user?: { firstName?: string | null; lastName?: string | null; email?: string | null } | null
  onComplete: () => void
}

export function OnboardingWizard({ user, onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<OnboardingStep>("welcome")
  const electron = useElectron()
  const { permissions } = usePermissions()

  const renderStep = () => {
    switch (step) {
      case "welcome":
        return <WelcomeContent firstName={user?.firstName} onContinue={() => setStep("fda")} />
      case "fda":
        return (
          <FDAContent
            granted={permissions?.fullDiskAccess ?? false}
            onOpenSettings={() => electron.permissions.openFullDiskAccessSettings()}
            onContinue={() => setStep("contacts")}
          />
        )
      case "contacts":
        return (
          <ContactsContent
            granted={permissions?.contacts ?? false}
            onOpenSettings={() => electron.permissions.openContactsSettings()}
            onContinue={() => setStep("complete")}
          />
        )
      case "complete":
        return (
          <CompletionContent
            fdaGranted={permissions?.fullDiskAccess ?? false}
            contactsGranted={permissions?.contacts ?? false}
            onFinish={onComplete}
          />
        )
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <div className="drag-region fixed top-0 left-0 right-0 h-[50px] z-[var(--z-titlebar)]" />
      <main className="flex flex-1 items-center justify-center p-8">
        {renderStep()}
      </main>
    </div>
  )
}

// =============================================================================
// STEP CONTENT
// =============================================================================

function WelcomeContent({ firstName, onContinue }: { firstName?: string | null; onContinue: () => void }) {
  const greeting = firstName ? `Welcome to Cued, ${firstName}!` : "Welcome to Cued!"

  return (
    <StepFormLayout
      title={greeting}
      description="Let's get your messaging set up. This takes about a minute."
      actions={
        <ContinueButton onClick={onContinue} className="w-full">
          Get Started
        </ContinueButton>
      }
    />
  )
}

function FDAContent({
  granted,
  onOpenSettings,
  onContinue,
}: {
  granted: boolean
  onOpenSettings: () => void
  onContinue: () => void
}) {
  return (
    <StepFormLayout
      icon={<HardDrive />}
      title="Enable Full Disk Access"
      description="Cued reads your iMessage database to sync conversations. Grant Full Disk Access in System Settings."
      actions={
        <ContinueButton onClick={onContinue} className="w-full">
          Continue
        </ContinueButton>
      }
    >
      <div className="space-y-4">
        <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
          <li>Open <span className="text-foreground font-medium">System Settings</span></li>
          <li>Go to <span className="text-foreground font-medium">Privacy & Security → Full Disk Access</span></li>
          <li>Toggle <span className="text-foreground font-medium">Cued</span> on</li>
        </ol>

        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={onOpenSettings}>
            Open System Settings
          </Button>
          {granted && (
            <Badge variant="secondary" className="bg-green-500/10 text-green-500">
              Granted
            </Badge>
          )}
        </div>
      </div>
    </StepFormLayout>
  )
}

function ContactsContent({
  granted,
  onOpenSettings,
  onContinue,
}: {
  granted: boolean
  onOpenSettings: () => void
  onContinue: () => void
}) {
  return (
    <StepFormLayout
      icon={<Users />}
      title="Allow Contacts Access"
      description="Cued matches messages to your contacts so you know who's reaching out."
      actions={
        <ContinueButton onClick={onContinue} className="w-full">
          Continue
        </ContinueButton>
      }
    >
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={onOpenSettings}>
          Grant Access
        </Button>
        {granted && (
          <Badge variant="secondary" className="bg-green-500/10 text-green-500">
            Granted
          </Badge>
        )}
      </div>
    </StepFormLayout>
  )
}

function CompletionContent({
  fdaGranted,
  contactsGranted,
  onFinish,
}: {
  fdaGranted: boolean
  contactsGranted: boolean
  onFinish: () => void
}) {
  return (
    <StepFormLayout
      icon={<Check />}
      iconVariant="success"
      title="You're all set!"
      description="Cued will start syncing your messages in the background."
      actions={
        <ContinueButton onClick={onFinish} className="w-full">
          Start using Cued
        </ContinueButton>
      }
    >
      <div className="space-y-2">
        <PermissionSummaryRow label="Full Disk Access" granted={fdaGranted} />
        <PermissionSummaryRow label="Contacts" granted={contactsGranted} />
      </div>
    </StepFormLayout>
  )
}

function PermissionSummaryRow({ label, granted }: { label: string; granted: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {granted ? (
        <Check className="size-4 text-green-500" />
      ) : (
        <X className="size-4 text-muted-foreground" />
      )}
      <span className={granted ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </div>
  )
}
