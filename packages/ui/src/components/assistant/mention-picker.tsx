import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { UserIcon } from "lucide-react"
import { createPortal } from "react-dom"
import { getInitials } from "@cued/shared"
import { cn } from "../../lib/utils"
import { Avatar, AvatarFallback } from "../ui/avatar"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "../ui/command"
import type { MentionSearchResult } from "./mention-types"

export interface MentionPickerProps {
  /** Whether the picker is open */
  open: boolean
  /** Search query for filtering contacts */
  query: string
  /** Anchor rectangle for positioning (from caret position) */
  anchorRect: DOMRect | null
  /** Called when a contact is selected, with optional context for disambiguation */
  onSelect: (contact: MentionSearchResult, context?: string | null) => void
  /** Called when picker should close */
  onClose: () => void
  /** Function to search contacts */
  searchFn: (query: string) => Promise<MentionSearchResult[]>
  /** Currently selected index for keyboard navigation */
  selectedIndex?: number
  /** Callback to update selected index */
  onSelectedIndexChange?: (index: number) => void
  /** Called when contacts list changes, provides length for bounds checking */
  onContactsChange?: (contacts: MentionSearchResult[]) => void
  /** Container element for portal (defaults to document.body) */
  container?: HTMLElement | null
}

export function MentionPicker({
  open,
  query,
  anchorRect,
  onSelect,
  onClose,
  searchFn,
  selectedIndex = 0,
  onSelectedIndexChange,
  onContactsChange,
  container,
}: MentionPickerProps) {
  const [contacts, setContacts] = useState<MentionSearchResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track query version to prevent race conditions with out-of-order responses
  const queryVersionRef = useRef(0)

  // Search contacts when query changes
  useEffect(() => {
    if (!open) {
      setContacts([])
      return
    }

    // Track if effect was cancelled (unmount or deps changed)
    let cancelled = false

    // Debounce search
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
    }

    // Increment version for this query
    const currentVersion = ++queryVersionRef.current

    setIsLoading(true)
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const results = await searchFn(query || "")
        // Only update if not cancelled and this is the latest query
        if (!cancelled && currentVersion === queryVersionRef.current) {
          setContacts(results)
        }
      } catch (error) {
        if (!cancelled && currentVersion === queryVersionRef.current) {
          console.error("Failed to search contacts:", error)
          setContacts([])
        }
      } finally {
        if (!cancelled && currentVersion === queryVersionRef.current) {
          setIsLoading(false)
        }
      }
    }, 150) // 150ms debounce for responsive feel

    return () => {
      cancelled = true
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }
    }
  }, [open, query, searchFn])

  // Reset selected index and notify parent when contacts change
  useEffect(() => {
    onSelectedIndexChange?.(0)
    onContactsChange?.(contacts)
  }, [contacts, onSelectedIndexChange, onContactsChange])

  // Detect duplicate names to show additional metadata
  const duplicateNames = useMemo(() => {
    const dups = new Set<string>()
    const nameCounts = new Map<string, number>()
    for (const contact of contacts) {
      const name = contact.displayName?.toLowerCase() || ""
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1)
    }
    for (const [name, count] of nameCounts) {
      if (count > 1) dups.add(name)
    }
    return dups
  }, [contacts])

  // Get secondary info for a contact (for disambiguation)
  const getSecondaryInfo = (contact: MentionSearchResult): string | null => {
    // Check if this name has duplicates
    const name = contact.displayName?.toLowerCase() || ""
    if (!duplicateNames.has(name)) return contact.company || null

    // For duplicates, show company first, then email/phone
    if (contact.company) return contact.company
    const emailHandle = contact.handles?.find((h) => h.type === "email")
    if (emailHandle) return emailHandle.value
    const phoneHandle = contact.handles?.find((h) => h.type === "phone")
    if (phoneHandle) return phoneHandle.value
    return null
  }

  // Handle click outside - use mousedown with a small delay to allow click to complete first
  useEffect(() => {
    if (!open) return

    function handleClickOutside(event: MouseEvent) {
      // Check if the click target is inside our container
      if (
        containerRef.current &&
        containerRef.current.contains(event.target as Node)
      ) {
        // Click is inside the picker, don't close
        return
      }
      // Click is outside, close the picker
      onClose()
    }

    // Use click instead of mousedown to allow selection to complete first
    document.addEventListener("click", handleClickOutside, true)
    return () => document.removeEventListener("click", handleClickOutside, true)
  }, [open, onClose])

  const handleSelect = useCallback(
    (contact: MentionSearchResult) => {
      // Check if this contact has a duplicate name
      const name = contact.displayName?.toLowerCase() || ""
      const hasDuplicate = duplicateNames.has(name)

      // Get context for disambiguation if duplicate
      let context: string | null = null
      if (hasDuplicate) {
        if (contact.company) {
          context = contact.company
        } else {
          const emailHandle = contact.handles?.find((h) => h.type === "email")
          if (emailHandle) {
            context = emailHandle.value
          } else {
            const phoneHandle = contact.handles?.find((h) => h.type === "phone")
            if (phoneHandle) {
              context = phoneHandle.value
            }
          }
        }
      }

      onSelect(contact, context)
    },
    [onSelect, duplicateNames]
  )

  if (!open || !anchorRect) return null

  // SSR safety check - document may not be available during server rendering
  if (typeof document === "undefined") return null

  // Calculate position - show above or below caret based on available space
  const viewportHeight = window.innerHeight
  const spaceBelow = viewportHeight - anchorRect.bottom
  const showAbove = spaceBelow < 250 && anchorRect.top > 250

  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 280)),
    ...(showAbove
      ? { bottom: viewportHeight - anchorRect.top + 4 }
      : { top: anchorRect.bottom + 4 }),
    zIndex: 50,
  }

  const pickerContent = (
    <div
      ref={containerRef}
      style={style}
      className={cn(
        "w-72 rounded-lg border border-border bg-popover shadow-lg",
        "animate-in fade-in-0 zoom-in-95",
        showAbove ? "slide-in-from-bottom-2" : "slide-in-from-top-2"
      )}
    >
      <Command
        className="border-none shadow-none"
        shouldFilter={false}
        loop
      >
        <CommandList className="max-h-60">
          {isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Searching...
            </div>
          ) : contacts.length === 0 ? (
            <CommandEmpty>
              {query ? "No contacts found" : "Type to search contacts"}
            </CommandEmpty>
          ) : (
            <CommandGroup>
              {contacts.map((contact, index) => (
                <CommandItem
                  key={contact._id}
                  value={contact._id}
                  onSelect={() => handleSelect(contact)}
                  onMouseDown={(e) => {
                    // Prevent blur on textarea when clicking
                    e.preventDefault()
                  }}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    handleSelect(contact)
                  }}
                  data-selected={index === selectedIndex}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2"
                >
                  <Avatar size="sm">
                    <AvatarFallback>
                      {contact.displayName ? (
                        getInitials(contact.displayName)
                      ) : (
                        <UserIcon className="size-3" />
                      )}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col overflow-hidden">
                    <span className="truncate font-medium">
                      {contact.displayName}
                    </span>
                    {(() => {
                      const secondaryInfo = getSecondaryInfo(contact)
                      return secondaryInfo ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {secondaryInfo}
                        </span>
                      ) : null
                    })()}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </div>
  )

  return createPortal(pickerContent, container || document.body)
}

export { type MentionSearchResult }
