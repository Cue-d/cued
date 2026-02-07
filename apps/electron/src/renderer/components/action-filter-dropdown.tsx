import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Command as CommandPrimitive } from "cmdk"
import { Check, ListFilter } from "lucide-react"
import { createPortal } from "react-dom"
import { PLATFORM_CONFIG, type ActionPlatform } from "@cued/shared"
import { ACTION_FILTER_GROUPS, getGroupCount, type FilterGroup, cn, PlatformIcon, Tooltip, TooltipTrigger, TooltipContent } from "@cued/ui"

export { type FilterGroup }

export interface FilterToggle {
  label: string
  active: boolean
  onToggle: () => void
}

export interface ActionFilterDropdownProps {
  /** Counts by action type { respond: 5, resolve_contact: 3, ... } */
  counts: Record<string, number>
  /** Total count of all actions */
  total: number
  /** Currently active filter group */
  activeFilter: FilterGroup
  /** Called when filter changes */
  onFilterChange: (filter: FilterGroup) => void
  /** Platform counts { imessage: 5, gmail: 3, ... } */
  platformCounts?: Partial<Record<ActionPlatform, number>>
  /** Currently active platform filters */
  activePlatforms?: Set<ActionPlatform>
  /** Called when platform filter is toggled */
  onPlatformToggle?: (platform: ActionPlatform) => void
  /** Boolean toggle filters (e.g. "Named contacts only") */
  toggles?: FilterToggle[]
  /** Optional class name */
  className?: string
}

export interface ActionFilterDropdownRef {
  open: () => void
}

const MENU_WIDTH = 220
const MENU_OFFSET = 6
const MENU_MIN_MARGIN = 8
const MENU_ESTIMATED_HEIGHT = 320

export const ActionFilterDropdown = forwardRef<ActionFilterDropdownRef, ActionFilterDropdownProps>(function ActionFilterDropdown({
  counts,
  total,
  activeFilter,
  onFilterChange,
  platformCounts,
  activePlatforms,
  onPlatformToggle,
  toggles,
  className,
}: ActionFilterDropdownProps, ref) {
  const groups = Object.entries(ACTION_FILTER_GROUPS) as [
    FilterGroup,
    (typeof ACTION_FILTER_GROUPS)[FilterGroup]
  ][]

  const hasActiveFilter = activeFilter !== "all" || (activePlatforms != null && activePlatforms.size > 0) || (toggles?.some(t => t.active) ?? false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const [menuHeight, setMenuHeight] = useState<number | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    open: () => setOpen(true),
  }), [])

  const updateAnchor = useCallback(() => {
    if (!triggerRef.current) return
    setAnchorRect(triggerRef.current.getBoundingClientRect())
  }, [])

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      if (prev) {
        setQuery("")
      }
      return !prev
    })
  }, [])

  useEffect(() => {
    if (!open) return
    updateAnchor()
    const handleResize = () => updateAnchor()
    window.addEventListener("resize", handleResize)
    window.addEventListener("scroll", handleResize, true)
    return () => {
      window.removeEventListener("resize", handleResize)
      window.removeEventListener("scroll", handleResize, true)
    }
  }, [open, updateAnchor])

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside, true)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside, true)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    if (!menuRef.current) return
    setMenuHeight(menuRef.current.getBoundingClientRect().height)
  }, [open, query, counts, total, platformCounts])

  // Build platform entries
  const platformEntries = useMemo(() => {
    if (!platformCounts) return []
    return (Object.entries(platformCounts) as [ActionPlatform, number][])
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a)
  }, [platformCounts])

  // Filter both groups and platforms by search query
  const normalized = useMemo(() => query.trim().toLowerCase(), [query])

  const filteredGroups = useMemo(() => {
    return groups
      .map(([key, config]) => {
        const count = getGroupCount(key, counts, total)
        const isActive = activeFilter === key
        return { key, config, count, isActive }
      })
      .filter((item) => {
        if (item.count === 0 && item.key !== "all") return false
        if (!normalized) return true
        return item.config.label.toLowerCase().includes(normalized)
      })
  }, [groups, counts, total, activeFilter, normalized])

  const filteredPlatforms = useMemo(() => {
    if (!normalized) return platformEntries
    return platformEntries.filter(([platform]) =>
      PLATFORM_CONFIG[platform].label.toLowerCase().includes(normalized)
    )
  }, [platformEntries, normalized])

  const showPlatformSection = filteredPlatforms.length > 0

  const menuContent = open && anchorRect && typeof document !== "undefined"
    ? (() => {
        const estimatedHeight = menuHeight ?? MENU_ESTIMATED_HEIGHT
        const spaceBelow = window.innerHeight - anchorRect.bottom
        const showAbove = spaceBelow < estimatedHeight && anchorRect.top > estimatedHeight
        const top = showAbove
          ? anchorRect.top - estimatedHeight - MENU_OFFSET
          : anchorRect.bottom + MENU_OFFSET
        const left = Math.min(
          window.innerWidth - MENU_WIDTH - MENU_MIN_MARGIN,
          Math.max(MENU_MIN_MARGIN, anchorRect.right - MENU_WIDTH)
        )

        return createPortal(
          <div
            ref={menuRef}
            className="no-drag fixed z-[var(--z-dropdown)]"
            style={{ top, left, width: MENU_WIDTH }}
          >
            <CommandPrimitive
              shouldFilter={false}
              className="w-full overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
            >
              <div className="border-b border-foreground/10 px-3 py-2">
                <CommandPrimitive.Input
                  ref={inputRef}
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Filter..."
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
                />
              </div>
              <CommandPrimitive.List className="max-h-[280px] overflow-y-auto p-1">
                <CommandPrimitive.Empty className="py-3 text-center text-sm text-muted-foreground">
                  No filters found
                </CommandPrimitive.Empty>

                {/* Type filters */}
                {filteredGroups.length > 0 && (
                  <>
                    {showPlatformSection && (
                      <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground/70">
                        Type
                      </div>
                    )}
                    {filteredGroups.map(({ key, config, count, isActive }) => (
                      <CommandPrimitive.Item
                        key={key}
                        value={config.label}
                        onSelect={() => {
                          onFilterChange(key)
                          setOpen(false)
                          setQuery("")
                        }}
                        className={cn(
                          "flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-1.5 text-[13px] outline-none",
                          isActive
                            ? "bg-foreground/7"
                            : "data-[selected=true]:bg-foreground/3"
                        )}
                      >
                        <span className="flex items-center justify-center w-3.5 shrink-0">
                          {isActive && <Check className="h-3.5 w-3.5" />}
                        </span>
                        <span className="flex-1 min-w-0">{config.label}</span>
                        <span className="text-muted-foreground/60 text-xs tabular-nums">
                          {count}
                        </span>
                      </CommandPrimitive.Item>
                    ))}
                  </>
                )}

                {/* Platform filters */}
                {showPlatformSection && (
                  <>
                    {filteredGroups.length > 0 && (
                      <div className="my-1 h-px bg-foreground/5" />
                    )}
                    <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground/70">
                      Platform
                    </div>
                    {filteredPlatforms.map(([platform, count]) => {
                      const config = PLATFORM_CONFIG[platform]
                      const isActive = activePlatforms?.has(platform) ?? false
                      return (
                        <CommandPrimitive.Item
                          key={platform}
                          value={config.label}
                          onSelect={() => {
                            onPlatformToggle?.(platform)
                          }}
                          className={cn(
                            "flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-1.5 text-[13px] outline-none",
                            isActive
                              ? "bg-foreground/7"
                              : "data-[selected=true]:bg-foreground/3"
                          )}
                        >
                          <span className="flex items-center justify-center w-3.5 shrink-0">
                            {isActive ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <PlatformIcon platform={platform} className={cn("h-3.5 w-3.5", config.textClass)} />
                            )}
                          </span>
                          <span className="flex-1 min-w-0">{config.label}</span>
                          <span className="text-muted-foreground/60 text-xs tabular-nums">
                            {count}
                          </span>
                        </CommandPrimitive.Item>
                      )
                    })}
                  </>
                )}

                {/* Toggle filters */}
                {toggles && toggles.length > 0 && (
                  <>
                    {(filteredGroups.length > 0 || showPlatformSection) && (
                      <div className="my-1 h-px bg-foreground/5" />
                    )}
                    <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground/70">
                      Display
                    </div>
                    {toggles.map((toggle) => (
                      <CommandPrimitive.Item
                        key={toggle.label}
                        value={toggle.label}
                        onSelect={() => toggle.onToggle()}
                        className={cn(
                          "flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-1.5 text-[13px] outline-none",
                          toggle.active
                            ? "bg-foreground/7"
                            : "data-[selected=true]:bg-foreground/3"
                        )}
                      >
                        <span className="flex items-center justify-center w-3.5 shrink-0">
                          {toggle.active && <Check className="h-3.5 w-3.5" />}
                        </span>
                        <span className="flex-1 min-w-0">{toggle.label}</span>
                      </CommandPrimitive.Item>
                    ))}
                  </>
                )}
              </CommandPrimitive.List>
            </CommandPrimitive>
          </div>,
          document.body
        )
      })()
    : null

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={handleToggle}
          className={cn(
            "inline-flex items-center justify-center no-drag cursor-pointer",
            "h-7 w-7 shrink-0 rounded-[4px]",
            "text-muted-foreground hover:text-foreground hover:bg-foreground/3",
            "data-[state=open]:text-foreground data-[state=open]:bg-foreground/3",
            "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            hasActiveFilter && "text-foreground",
            className
          )}
          data-state={open ? "open" : "closed"}
          render={<button ref={triggerRef} type="button" />}
        >
          <ListFilter className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span className="flex items-center gap-1.5">
            Filter
            <kbd className="rounded bg-background/20 px-1 py-0.5 font-mono text-[10px]">F</kbd>
          </span>
        </TooltipContent>
      </Tooltip>
      {menuContent}
    </>
  )
})
