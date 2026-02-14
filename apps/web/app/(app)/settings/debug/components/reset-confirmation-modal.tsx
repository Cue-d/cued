"use client";

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Label,
} from "@cued/ui";
import type { ResettablePlatform } from "../platform-types";

const PLATFORM_NAMES: Record<ResettablePlatform, string> = {
  imessage: "iMessage",
  slack: "Slack",
  linkedin: "LinkedIn",
};

interface ResetConfirmationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platforms: ResettablePlatform[] | null; // null = all platforms
  onConfirm: () => Promise<void>;
  isResetting: boolean;
}

export function ResetConfirmationModal({
  open,
  onOpenChange,
  platforms,
  onConfirm,
  isResetting,
}: ResetConfirmationModalProps) {
  const [confirmText, setConfirmText] = useState("");

  const isConfirmValid = confirmText === "RESET";
  const platformsText =
    platforms === null
      ? "all platforms"
      : platforms.map((p) => PLATFORM_NAMES[p]).join(", ");

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) {
      setConfirmText("");
    }
    onOpenChange(newOpen);
  }

  async function handleConfirm() {
    if (!isConfirmValid) return;
    await onConfirm();
    setConfirmText("");
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset Sync Data?</AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <p>
              This will delete all synced data for{" "}
              <strong>{platformsText}</strong> and disconnect the integrations.
            </p>
            <p>
              This action cannot be undone. You will need to reconnect and
              re-sync your data.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="py-4">
          <Label htmlFor="confirm-reset" className="text-sm">
            Type <strong>RESET</strong> to confirm
          </Label>
          <Input
            id="confirm-reset"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
            placeholder="RESET"
            className="mt-2"
            disabled={isResetting}
          />
        </div>

        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isResetting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!isConfirmValid || isResetting}
          >
            {isResetting ? (
              <>
                <Loader2Icon className="size-4 mr-2 animate-spin" />
                Resetting...
              </>
            ) : (
              "Reset Data"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
