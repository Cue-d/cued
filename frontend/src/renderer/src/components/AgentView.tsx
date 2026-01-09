import { MessageSquare, Search, User } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { searchMessages } from '@/api/actions'
import { Badge } from '@/components/ui/badge'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import type { SearchResultResponse } from '@/data/types'

export function AgentView() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultResponse[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

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
    <div className="w-full h-full flex items-center justify-center bg-imessage-window-bg p-8 overflow-hidden">
      <div className="w-full max-w-2xl">
        <Command className="**:[[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 **:[[cmdk-input]]:h-12 **:[[cmdk-item]]:px-2 **:[[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5 rounded-lg border bg-background shadow-lg">
          <div className="flex items-center border-b px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search messages..."
              className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <CommandList className="max-h-[500px]">
            {!query && (
              <CommandGroup heading="Search">
                <CommandEmpty>Start typing to search messages...</CommandEmpty>
              </CommandGroup>
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
        </Command>
      </div>
    </div>
  )
}
