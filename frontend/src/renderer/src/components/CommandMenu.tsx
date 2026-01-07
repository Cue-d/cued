import { MessageSquare, Search, Sparkles, User, Target } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { searchMessages } from '@/api/actions'
import { Badge } from '@/components/ui/badge'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import type { SearchResultResponse } from '@/data/types'
import { useView } from '@/hooks/useView'
import { VIEWS, VIEW_ORDER, type ViewType } from '@/types/views'

const NAV_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Target,
  Sparkles
}

// Hook that safely uses view context (for cases where CommandMenu might be used outside ViewProvider)
function useViewSafe() {
  try {
    return useView()
  } catch {
    // Return a no-op if ViewContext is not available
    return {
      currentView: 'action-queue' as ViewType,
      setView: () => {},
      navigateNext: () => {},
      navigatePrevious: () => {}
    }
  }
}

interface CommandMenuProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function CommandMenu({ open: controlledOpen, onOpenChange }: CommandMenuProps) {
  const { currentView, setView } = useViewSafe()
  const [internalOpen, setInternalOpen] = useState(false)

  // Support both controlled and uncontrolled modes
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultResponse[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keyboard shortcut to open
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        // Toggle using internal state for uncontrolled mode, or callback for controlled
        if (onOpenChange) {
          onOpenChange(!controlledOpen)
        } else {
          setInternalOpen((prev) => !prev)
        }
      }
    }

    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [controlledOpen, onOpenChange])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
    }
  }, [open])

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    if (!query.trim()) {
      setResults([])
      return
    }

    debounceRef.current = setTimeout(async () => {
      setIsSearching(true)
      try {
        const searchResults = await searchMessages(query.trim(), 10)
        setResults(searchResults)
      } catch (error) {
        console.error('Search failed:', error)
        setResults([])
      } finally {
        setIsSearching(false)
      }
    }, 300)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [query])

  const formatTimestamp = (timestamp: number) => {
    if (!timestamp) return ''
    const date = new Date(timestamp * 1000)
    const now = new Date()
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

    if (diffDays === 0) {
      return date.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      })
    } else if (diffDays === 1) {
      return 'Yesterday'
    } else if (diffDays < 7) {
      return date.toLocaleDateString([], { weekday: 'short' })
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} showCloseButton={false}>
      <div className="flex items-center border-b px-3">
        <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search messages..."
          className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
      <CommandList className="max-h-[400px]">
        {!query && (
          <>
            <CommandGroup heading="Navigation">
              {VIEW_ORDER.map((viewId) => {
                const view = VIEWS[viewId]
                const IconComponent = NAV_ICON_MAP[view.icon]
                const isActive = currentView === viewId

                return (
                  <CommandItem
                    key={viewId}
                    onSelect={() => {
                      setView(viewId)
                      setOpen(false)
                    }}
                    className={isActive ? 'bg-accent' : ''}
                  >
                    {IconComponent && <IconComponent className="mr-2 h-4 w-4" />}
                    <span>{view.label}</span>
                    {view.shortcut && (
                      <span className="ml-auto text-xs text-muted-foreground">{view.shortcut}</span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
            <CommandGroup heading="Search">
              <CommandEmpty>Start typing to search messages...</CommandEmpty>
            </CommandGroup>
          </>
        )}

        {query && isSearching && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            <div className="flex items-center justify-center gap-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              Searching...
            </div>
          </div>
        )}

        {query && !isSearching && results.length === 0 && (
          <CommandEmpty>No messages found for &ldquo;{query}&rdquo;</CommandEmpty>
        )}

        {query && !isSearching && results.length > 0 && (
          <>
            <CommandGroup
              heading={
                <div className="flex items-center gap-2">
                  <span>Messages</span>
                  <Badge variant="secondary" className="text-xs">
                    {results.length} result{results.length !== 1 ? 's' : ''}
                  </Badge>
                </div>
              }
            >
              {results.map((result) => (
                <CommandItem
                  key={`${result.chat_id}-${result.message_id}`}
                  onSelect={() => {
                    // TODO: Navigate to message/chat
                    setOpen(false)
                  }}
                  className="flex flex-col items-start gap-1 py-3"
                >
                  <div className="flex w-full items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10">
                      {result.sender_name ? (
                        <User className="h-3.5 w-3.5 text-primary" />
                      ) : (
                        <MessageSquare className="h-3.5 w-3.5 text-primary" />
                      )}
                    </div>
                    <span className="font-medium text-foreground">
                      {result.chat_name || result.sender_name || 'Unknown'}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatTimestamp(result.timestamp)}
                    </span>
                  </div>
                  <p className="line-clamp-2 w-full pl-8 text-sm text-muted-foreground">
                    {result.text}
                  </p>
                  {result.rank > 0 && (
                    <div className="pl-8">
                      <Badge variant="outline" className="text-xs">
                        {Math.round(result.rank * 100)}% match
                      </Badge>
                    </div>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
