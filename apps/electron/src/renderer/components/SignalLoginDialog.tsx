import * as React from "react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@cued/ui"
import { CheckCircle2, XCircle, Loader2, Terminal } from "lucide-react"
import type {
  SignalLoginCredentials,
  SignalLoginResult,
  SignalSetupResult,
  SignalValidationStep,
} from "../../shared/electron-api"

type DialogStep = "form" | "installing" | "linking" | "success" | "error"

const STEP_LABELS: Record<SignalValidationStep["step"], string> = {
  java: "Checking Java runtime",
  install: "Installing signal-cli",
  link: "Linking device",
}

function StepIcon({ status }: { status: SignalValidationStep["status"] }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
    case "error":
      return <XCircle className="w-4 h-4 text-destructive shrink-0" />
    case "running":
    case "pending":
      return <Loader2 className="w-4 h-4 text-muted-foreground animate-spin shrink-0" />
  }
}

interface SignalLoginDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  setup: (credentials?: SignalLoginCredentials) => Promise<SignalSetupResult>
  openLinkTerminal: (cliPath: string) => Promise<{ success: boolean; error?: string }>
  checkLink: (cliPath: string) => Promise<SignalLoginResult>
}

export function SignalLoginDialog({
  open,
  onOpenChange,
  onSuccess,
  setup,
  openLinkTerminal,
  checkLink,
}: SignalLoginDialogProps) {
  const [dialogStep, setDialogStep] = React.useState<DialogStep>("form")
  const [cliPath, setCliPath] = React.useState("")
  const [validationSteps, setValidationSteps] = React.useState<SignalValidationStep[]>([])
  const [errorMessage, setErrorMessage] = React.useState("")
  const [resolvedCliPath, setResolvedCliPath] = React.useState("")
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  function reset() {
    setDialogStep("form")
    setCliPath("")
    setValidationSteps([])
    setErrorMessage("")
    setResolvedCliPath("")
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      reset()
    }
    onOpenChange(nextOpen)
  }

  async function handleConnect() {
    setDialogStep("installing")
    setValidationSteps([
      { step: "java", status: "running" },
      { step: "install", status: "pending" },
      { step: "link", status: "pending" },
    ])

    const credentials: SignalLoginCredentials = {
      cliPath: cliPath.trim() || undefined,
    }

    const result = await setup(credentials)

    // Update the displayed steps from the result
    if (result.steps) {
      setValidationSteps(result.steps.map((s) => ({
        ...s,
        // Keep link step as pending since it happens in terminal
        status: s.step === "link" ? "pending" : s.status,
      })))
    }

    if (!result.success) {
      setErrorMessage(result.error ?? "Setup failed")
      setDialogStep("error")
      return
    }

    // Setup succeeded — open Terminal.app for linking
    const effectiveCliPath = result.cliPath!
    setResolvedCliPath(effectiveCliPath)

    const linkResult = await openLinkTerminal(effectiveCliPath)
    if (!linkResult.success) {
      setErrorMessage(linkResult.error ?? "Failed to open terminal")
      setDialogStep("error")
      return
    }

    // Switch to linking state and start polling
    setDialogStep("linking")
    startPolling(effectiveCliPath)
  }

  function startPolling(cliPathToCheck: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      const result = await checkLink(cliPathToCheck)
      if (result.success) {
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
        setDialogStep("success")
      }
    }, 3000)
  }

  function handleVerifyNow() {
    if (resolvedCliPath) {
      checkLink(resolvedCliPath).then((result) => {
        if (result.success) {
          if (pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }
          setDialogStep("success")
        }
      })
    }
  }

  function handleDone() {
    onSuccess()
    handleOpenChange(false)
  }

  // Cleanup polling on unmount
  React.useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={dialogStep !== "installing"}>
        {dialogStep === "form" && (
          <>
            <DialogHeader>
              <DialogTitle>Connect Signal</DialogTitle>
              <DialogDescription>
                This will install signal-cli and link your Signal account by scanning a QR code.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="signal-cli-path">CLI path (optional)</Label>
                <Input
                  id="signal-cli-path"
                  placeholder="Auto-install"
                  value={cliPath}
                  onChange={(e) => setCliPath(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to auto-download signal-cli. Requires Java 21+.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleConnect}>
                Connect
              </Button>
            </DialogFooter>
          </>
        )}

        {dialogStep === "installing" && (
          <>
            <DialogHeader>
              <DialogTitle>Setting up Signal</DialogTitle>
              <DialogDescription>Checking dependencies and installing signal-cli...</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-4">
              {validationSteps.map((step) => (
                <div key={step.step} className="flex items-center gap-3">
                  <StepIcon status={step.status} />
                  <span className="text-sm">{STEP_LABELS[step.step]}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {dialogStep === "linking" && (
          <>
            <DialogHeader>
              <DialogTitle>Link Your Signal Account</DialogTitle>
              <DialogDescription>
                A terminal window has opened with a QR code.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                <Terminal className="w-5 h-5 text-muted-foreground shrink-0" />
                <div className="text-sm">
                  <p className="font-medium">Scan the QR code in Terminal</p>
                  <p className="text-muted-foreground mt-1">
                    Open Signal on your phone &rarr; Settings &rarr; Linked Devices &rarr; + &rarr; Scan
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Waiting for you to scan...</span>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="outline" onClick={handleVerifyNow}>
                Verify Now
              </Button>
            </DialogFooter>
          </>
        )}

        {dialogStep === "success" && (
          <>
            <DialogHeader>
              <DialogTitle>Signal Connected</DialogTitle>
              <DialogDescription>
                Your Signal account has been linked. Messages will now sync automatically.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-center py-4">
              <CheckCircle2 className="w-12 h-12 text-green-500" />
            </div>
            <DialogFooter>
              <Button onClick={handleDone}>Done</Button>
            </DialogFooter>
          </>
        )}

        {dialogStep === "error" && (
          <>
            <DialogHeader>
              <DialogTitle>Connection Failed</DialogTitle>
              <DialogDescription>
                Something went wrong during setup.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-4">
              {validationSteps.filter((s) => s.status !== "pending").map((step) => (
                <div key={step.step} className="space-y-1">
                  <div className="flex items-center gap-3">
                    <StepIcon status={step.status} />
                    <span className="text-sm">{STEP_LABELS[step.step]}</span>
                  </div>
                  {step.error && (
                    <p className="text-xs text-destructive ml-7">{step.error}</p>
                  )}
                </div>
              ))}
              {errorMessage && validationSteps.every((s) => !s.error) && (
                <p className="text-sm text-destructive">{errorMessage}</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="outline" onClick={() => setDialogStep("form")}>
                Back
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
