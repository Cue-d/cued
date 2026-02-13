"use client"

import * as React from "react"
import {
  InboxIcon,
  SettingsIcon,
  Search,
} from "lucide-react"
import { useRouter } from "next/navigation"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command"

interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
  shortcut?: string
}

const navItems: NavItem[] = [
  { label: "Inbox", href: "/inbox", icon: <InboxIcon className="w-4 h-4" />, shortcut: "⌘1" },
  { label: "Settings", href: "/settings", icon: <SettingsIcon className="w-4 h-4" /> },
]

interface CommandMenuProps {
  /** Controlled open state */
  open?: boolean
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void
}

export function CommandMenu({ open: controlledOpen, onOpenChange }: CommandMenuProps) {
  const router = useRouter()
  const [internalOpen, setInternalOpen] = React.useState(false)

  // Support controlled and uncontrolled modes
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen

  // Keyboard shortcut: Cmd+K to toggle, Cmd+1/2/3/4 for navigation
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Cmd+K to toggle command menu
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(!open)
        return
      }

      // Cmd+1/2 for quick navigation
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key)
        if (num >= 1 && num <= navItems.length) {
          e.preventDefault()
          const item = navItems[num - 1]
          if (item) {
            router.push(item.href)
          }
        }
      }
    }

    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [open, setOpen, router])

  const handleSelect = React.useCallback((href: string) => {
    setOpen(false)
    router.push(href)
  }, [setOpen, router])

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search or jump to..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Navigation">
          {navItems.map((item) => (
            <CommandItem
              key={item.href}
              onSelect={() => handleSelect(item.href)}
              className="flex items-center gap-2"
            >
              {item.icon}
              <span>{item.label}</span>
              {item.shortcut && (
                <CommandShortcut>{item.shortcut}</CommandShortcut>
              )}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => {
              setOpen(false)
              router.push("/inbox?platform=imessage")
            }}
          >
            <Search className="w-4 h-4" />
            <span>Filter iMessage</span>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false)
              router.push("/inbox?platform=slack")
            }}
          >
            <Search className="w-4 h-4" />
            <span>Filter Slack</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

export default CommandMenu
