import * as React from "react"
import { useQuery, useMutation } from "convex/react"
import { Loader2, ArrowLeft } from "lucide-react"
import { api } from "@cued/convex"
import type { Id } from "@cued/convex"
import {
  getInitials,
  MERGE_CONFLICT_FIELD_LABELS,
  isRealContactName,
  type ActionPlatform,
} from "@cued/shared"
import {
  Avatar,
  AvatarFallback,
  Button,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  PlatformIcon,
} from "@cued/ui"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@cued/ui"

type FieldResolutions = {
  displayName?: "primary" | "secondary"
  company?: "primary" | "secondary"
  notes?: "primary" | "secondary" | "merge"
}

type SearchContact = {
  _id: Id<"contacts">
  displayName: string
  company?: string | null
  handles?: Array<{ type: string; value: string; platform: string }>
}

function contactMatchesQuery(contact: SearchContact, normalizedQuery: string): boolean {
  if (!normalizedQuery) return false

  if (contact.displayName.toLowerCase().includes(normalizedQuery)) return true
  if ((contact.company ?? "").toLowerCase().includes(normalizedQuery)) return true

  return (contact.handles ?? []).some((handle) =>
    `${handle.value} ${handle.platform} ${handle.type}`
      .toLowerCase()
      .includes(normalizedQuery)
  )
}

interface MergeContactDialogProps {
  primaryContactId: Id<"contacts">
  open: boolean
  onClose: () => void
}

export function MergeContactDialog({ primaryContactId, open, onClose }: MergeContactDialogProps) {
  const [step, setStep] = React.useState<"search" | "preview">("search")
  const [secondaryContactId, setSecondaryContactId] = React.useState<Id<"contacts"> | null>(null)
  const [searchInput, setSearchInput] = React.useState("")
  const [resolutions, setResolutions] = React.useState<FieldResolutions>({})
  const [isMerging, setIsMerging] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const manualMerge = useMutation(api.contacts.manualMerge)

  // Search contacts
  const searchResults = useQuery(
    api.contacts.getContacts,
    open && step === "search" ? { searchQuery: searchInput || undefined, limit: 20 } : "skip"
  )

  // Merge preview
  const preview = useQuery(
    api.contacts.mergePreview,
    secondaryContactId ? { primaryContactId, secondaryContactId } : "skip"
  )

  const filteredContacts = React.useMemo(() => {
    if (!searchResults?.contacts) return []
    const normalizedQuery = searchInput.trim().toLowerCase()

    return (searchResults.contacts as SearchContact[]).filter((contact) => {
      if (contact._id === primaryContactId) return false

      if (isRealContactName(contact.displayName)) return true
      return contactMatchesQuery(contact, normalizedQuery)
    })
  }, [searchResults?.contacts, primaryContactId, searchInput])

  const handleReset = React.useCallback(() => {
    setStep("search")
    setSecondaryContactId(null)
    setSearchInput("")
    setResolutions({})
    setIsMerging(false)
    setError(null)
  }, [])

  const handleClose = React.useCallback(() => {
    onClose()
    // Delay reset so dialog animation completes
    setTimeout(handleReset, 200)
  }, [onClose, handleReset])

  const handleSelectContact = React.useCallback((contactId: Id<"contacts">) => {
    setSecondaryContactId(contactId)
    setStep("preview")
  }, [])

  const handleMerge = React.useCallback(async () => {
    if (!secondaryContactId) return
    setIsMerging(true)
    setError(null)
    try {
      await manualMerge({
        primaryContactId,
        secondaryContactId,
        fieldResolutions: Object.keys(resolutions).length > 0 ? resolutions : undefined,
      })
      handleClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed")
      setIsMerging(false)
    }
  }, [secondaryContactId, primaryContactId, resolutions, manualMerge, handleClose])

  if (step === "search") {
    return (
      <CommandDialog
        open={open}
        onOpenChange={(isOpen) => { if (!isOpen) handleClose() }}
        title="Merge with contact"
        description="Search for a contact to merge into this one"
        className="sm:max-w-xl [&_[data-slot=command-input-wrapper]]:border-b-0"
      >
        <CommandInput
          placeholder="Search contacts..."
          value={searchInput}
          onValueChange={setSearchInput}
        />
        <CommandList className="max-h-[420px]">
          <CommandEmpty>No contacts found.</CommandEmpty>
          <CommandGroup className="space-y-0.5">
            {filteredContacts.map((contact) => {
              const platforms = [...new Set((contact.handles ?? []).map((handle) => handle.platform))]

              return (
                <CommandItem
                  key={contact._id}
                  value={[
                    contact.displayName,
                    contact.company ?? "",
                    ...(contact.handles ?? []).map((handle) => handle.value),
                    ...(contact.handles ?? []).map((handle) => handle.platform),
                  ].join(" ")}
                  onSelect={() => handleSelectContact(contact._id as Id<"contacts">)}
                  className="px-2 py-1.5 transition-colors duration-100 hover:bg-muted/50 data-selected:bg-muted active:bg-muted"
                >
                  <div className="flex items-center gap-2 w-full min-w-0">
                    <Avatar className="size-5" size="sm">
                      <AvatarFallback className="text-[10px]">{getInitials(contact.displayName)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="text-[13px] font-medium truncate">{contact.displayName}</p>
                        {platforms.length > 0 && (
                          <div className="flex items-center gap-0.5">
                            {platforms.slice(0, 3).map((platform) => (
                              <PlatformIcon
                                key={platform}
                                platform={platform as ActionPlatform}
                                className="w-2.5 h-2.5 opacity-80"
                              />
                            ))}
                          </div>
                        )}
                      </div>
                      {contact.company && (
                        <p className="text-xs text-muted-foreground truncate">{contact.company}</p>
                      )}
                    </div>
                  </div>
                </CommandItem>
              )
            })}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    )
  }

  // Preview + conflict resolution step
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge Contacts</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{preview?.secondary.displayName}</span>
            {" will be merged into "}
            <span className="font-medium text-foreground">{preview?.primary.displayName}</span>
            {" and deleted."}
          </DialogDescription>
        </DialogHeader>

        {preview === undefined ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : preview === null ? (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground text-center">
              That contact is no longer available. It may have already been merged or removed.
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => { setStep("search"); setSecondaryContactId(null); setResolutions({}); }}
            >
              <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
              Back to Search
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            {/* Conflicts */}
            {preview.conflicts.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium">Resolve conflicts</p>
                {preview.conflicts.map((conflict) => (
                  <div key={conflict.field} className="space-y-1.5">
                    <p className="text-xs text-muted-foreground font-medium">
                      {MERGE_CONFLICT_FIELD_LABELS[conflict.field] ?? conflict.field}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={`flex-1 text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                          resolutions[conflict.field as keyof FieldResolutions] !== "secondary" && resolutions[conflict.field as keyof FieldResolutions] !== "merge"
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-muted-foreground/30"
                        }`}
                        onClick={() => setResolutions((r) => ({ ...r, [conflict.field]: "primary" }))}
                      >
                        <span className="truncate block">{conflict.primaryValue || "\u2014"}</span>
                      </button>
                      <button
                        type="button"
                        className={`flex-1 text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                          resolutions[conflict.field as keyof FieldResolutions] === "secondary"
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-muted-foreground/30"
                        }`}
                        onClick={() => setResolutions((r) => ({ ...r, [conflict.field]: "secondary" }))}
                      >
                        <span className="truncate block">{conflict.secondaryValue || "\u2014"}</span>
                      </button>
                    </div>
                    {conflict.field === "notes" && (
                      <button
                        type="button"
                        className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                          resolutions.notes === "merge"
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-muted-foreground/30"
                        }`}
                        onClick={() => setResolutions((r) => ({ ...r, notes: "merge" }))}
                      >
                        Merge both notes
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            {/* Actions */}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => { setStep("search"); setSecondaryContactId(null); setResolutions({}); }}>
                <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
                Back
              </Button>
              <Button className="flex-1" onClick={handleMerge} disabled={isMerging}>
                {isMerging ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  "Merge Contacts"
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
