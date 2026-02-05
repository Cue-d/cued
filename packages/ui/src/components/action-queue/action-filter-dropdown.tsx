"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Command as CommandPrimitive } from "cmdk"
import { Check, ListFilter } from "lucide-react"
import { createPortal } from "react-dom"
import { ACTION_FILTER_GROUPS, getGroupCount, type FilterGroup } from "./filter-utils"
import { cn } from "../../lib/utils"

export { type FilterGroup }

export interface ActionFilterDropdownProps {
  /** Counts by action type { respond: 5, resolve_contact: 3, ... } */
  counts: Record<string, number>
  /** Total count of all actions */
  total: number
  /** Currently active filter group */
  activeFilter: FilterGroup
  /** Called when filter changes */
  onFilterChange: (filter: FilterGroup) => void
  /** Optional class name */
  className?: string
}

const MENU_WIDTH = 200
const MENU_OFFSET = 6
const MENU_MIN_MARGIN = 8
const MENU_ESTIMATED_HEIGHT = 240

export function ActionFilterDropdown({
  counts,
  total,
  activeFilter,
  onFilterChange,
  className,
}: ActionFilterDropdownProps) {
  const groups = Object.entries(ACTION_FILTER_GROUPS) as [
    FilterGroup,
    (typeof ACTION_FILTER_GROUPS)[FilterGroup]
  ][]

  const hasActiveFilter = activeFilter !== "all"
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const [menuHeight, setMenuHeight] = useState<number | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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
  }, [open, query, counts, total])

  const filteredGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase()
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
  }, [groups, counts, total, activeFilter, query])

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
                <div className="text-xs font-medium text-muted-foreground">
                  Filter Actions
                </div>
                <CommandPrimitive.Input
                  ref={inputRef}
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search filters..."
                  className="mt-1 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                />
              </div>
              <CommandPrimitive.List className="max-h-[240px] overflow-y-auto p-1">
                <CommandPrimitive.Empty className="py-3 text-center text-sm text-muted-foreground">
                  No filters found
                </CommandPrimitive.Empty>
                {filteredGroups.map(({ key, config, count, isActive }) => (
                  <CommandPrimitive.Item
                    key={key}
                    value={config.label}
                    onSelect={() => {
                      onFilterChange(key)
                      setOpen(false)
                    }}
                    className={cn(
                      "flex cursor-pointer select-none items-center justify-between rounded-md px-2 py-1.5 text-sm outline-none",
                      "data-[selected=true]:bg-foreground/5"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {isActive && <Check className="h-3.5 w-3.5" />}
                      {!isActive && <span className="w-3.5" />}
                      {config.label}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {count}
                    </span>
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.List>
            </CommandPrimitive>
          </div>,
          document.body
        )
      })()
    : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleToggle}
        className={cn(
          "inline-flex items-center no-drag cursor-pointer bg-foreground/5 text-foreground/80 justify-center h-8 w-8 rounded-md text-sm font-medium transition-colors",
          "hover:bg-foreground/10 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          hasActiveFilter && "bg-accent/20 text-accent-foreground",
          className
        )}
      >
        <ListFilter className="h-4 w-4" />
      </button>
      {menuContent}
    </>
  )
}

export default ActionFilterDropdown
