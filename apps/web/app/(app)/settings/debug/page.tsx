"use client";

import { useState } from "react";
import Link from "next/link";
import { useAction } from "convex/react";
import {
  ArrowLeftIcon,
  AlertTriangleIcon,
  TrashIcon,
  Loader2Icon,
  CheckCircleIcon,
} from "lucide-react";
import { api } from "@cued/convex";
import {
  Button,
  Checkbox,
  Label,
  RadioGroup,
  RadioGroupItem,
} from "@cued/ui";
import { ResetConfirmationModal } from "./components/reset-confirmation-modal";
import type { ResettablePlatform } from "./platform-types";

const PLATFORMS: { id: ResettablePlatform; name: string }[] = [
  { id: "imessage", name: "iMessage" },
  { id: "slack", name: "Slack" },
  { id: "linkedin", name: "LinkedIn" },
];

export default function DebugSettingsPage() {
  const resetPlatformData = useAction(api.debug.resetPlatformData);

  const [resetMode, setResetMode] = useState<"all" | "specific">("all");
  const [selectedPlatforms, setSelectedPlatforms] = useState<ResettablePlatform[]>([]);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetResult, setResetResult] = useState<{
    success: boolean;
    totalDeleted: number;
    integrationsDisconnected: number;
    byTable: Record<string, number>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canReset =
    resetMode === "all" ||
    (resetMode === "specific" && selectedPlatforms.length > 0);

  function handlePlatformToggle(platform: ResettablePlatform) {
    setSelectedPlatforms((prev) =>
      prev.includes(platform)
        ? prev.filter((p) => p !== platform)
        : [...prev, platform]
    );
  }

  async function handleConfirmReset() {
    setIsResetting(true);
    setError(null);
    setResetResult(null);

    try {
      const result = await resetPlatformData({
        platforms: resetMode === "all" ? undefined : selectedPlatforms,
        confirmReset: "CONFIRM_RESET",
      });
      setResetResult(result);
      setShowConfirmModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setIsResetting(false);
    }
  }

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
        <h1 className="text-lg font-semibold">Debug Tools</h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 p-6">
          {/* Warning Banner */}
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
            <div className="flex gap-3">
              <AlertTriangleIcon className="size-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-medium text-amber-500">
                  Development Only
                </h3>
                <p className="text-sm text-amber-500/80 mt-1">
                  These tools are for debugging and testing. Resetting data will
                  simulate a fresh signup experience.
                </p>
              </div>
            </div>
          </div>

          {/* Reset Section */}
          <section>
            <div className="mb-4">
              <h2 className="text-sm font-medium text-foreground">
                Reset Sync Data
              </h2>
              <p className="text-sm text-muted-foreground">
                Delete synced data and disconnect integrations to simulate a
                fresh account
              </p>
            </div>

            <div className="rounded-lg border bg-card p-4 space-y-4">
              {/* Reset Mode Selection */}
              <RadioGroup
                value={resetMode}
                onValueChange={(v) => setResetMode(v as "all" | "specific")}
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="all" id="reset-all" />
                  <Label htmlFor="reset-all" className="cursor-pointer">
                    Reset all platforms
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="specific" id="reset-specific" />
                  <Label htmlFor="reset-specific" className="cursor-pointer">
                    Reset specific platforms
                  </Label>
                </div>
              </RadioGroup>

              {/* Platform Selection */}
              {resetMode === "specific" && (
                <div className="ml-6 space-y-2 border-l-2 border-muted pl-4">
                  {PLATFORMS.map((platform) => (
                    <div
                      key={platform.id}
                      className="flex items-center space-x-2"
                    >
                      <Checkbox
                        id={`platform-${platform.id}`}
                        checked={selectedPlatforms.includes(platform.id)}
                        onCheckedChange={() => handlePlatformToggle(platform.id)}
                      />
                      <Label
                        htmlFor={`platform-${platform.id}`}
                        className="cursor-pointer"
                      >
                        {platform.name}
                      </Label>
                    </div>
                  ))}
                </div>
              )}

              {/* Reset Button */}
              <div className="pt-2">
                <Button
                  variant="destructive"
                  onClick={() => setShowConfirmModal(true)}
                  disabled={!canReset || isResetting}
                  className="w-full sm:w-auto"
                >
                  {isResetting ? (
                    <>
                      <Loader2Icon className="size-4 mr-2 animate-spin" />
                      Resetting...
                    </>
                  ) : (
                    <>
                      <TrashIcon className="size-4 mr-2" />
                      Reset Sync Data
                    </>
                  )}
                </Button>
              </div>

              {/* Error Display */}
              {error && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                  <p className="text-sm text-destructive">{error}</p>
                </div>
              )}

              {/* Success Display */}
              {resetResult && (
                <div className="rounded-lg border border-green-500/50 bg-green-500/10 p-4">
                  <div className="flex gap-3">
                    <CheckCircleIcon className="size-5 text-green-500 shrink-0 mt-0.5" />
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium text-green-600">
                        Reset Complete
                      </h3>
                      <div className="text-sm text-green-600/80 space-y-1">
                        <p>
                          <strong>{resetResult.totalDeleted}</strong> records
                          deleted
                        </p>
                        <p>
                          <strong>{resetResult.integrationsDisconnected}</strong>{" "}
                          integrations disconnected
                        </p>
                      </div>
                      <details className="text-xs text-green-600/70">
                        <summary className="cursor-pointer">
                          View details
                        </summary>
                        <pre className="mt-2 p-2 bg-green-500/5 rounded overflow-x-auto">
                          {JSON.stringify(resetResult.byTable, null, 2)}
                        </pre>
                      </details>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* What Gets Deleted */}
          <div className="rounded-lg border bg-muted/30 p-4">
            <h3 className="text-sm font-medium mb-2">What gets reset</h3>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>Messages and conversations</li>
              <li>Contacts and contact handles</li>
              <li>Sync cursors (will trigger full re-sync)</li>
              <li>Integration connections (set to disconnected)</li>
              <li>Actions and message queue</li>
              <li>Writing style profiles</li>
              {resetMode === "all" && (
                <>
                  <li>Memory extraction stats</li>
                  <li>Merge suggestions</li>
                </>
              )}
            </ul>
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      <ResetConfirmationModal
        open={showConfirmModal}
        onOpenChange={setShowConfirmModal}
        platforms={resetMode === "all" ? null : selectedPlatforms}
        onConfirm={handleConfirmReset}
        isResetting={isResetting}
      />
    </div>
  );
}
