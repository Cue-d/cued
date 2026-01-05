import { Search, SortAsc, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ActionType } from '@/data/types'
import { cn } from '@/lib/utils'

type SearchMode = 'fts' | 'semantic'
type SortBy = 'priority' | 'date' | 'type'

interface SearchBarProps {
  onSearch: (query: string, mode: SearchMode) => void
  onFilterChange: (filters: ActionType[]) => void
  onSortChange: (sort: SortBy) => void
  className?: string
}

const FILTER_OPTIONS: { type: ActionType; label: string }[] = [
  { type: 'respond_to_message', label: 'Messages' },
  { type: 'eod_contact', label: 'Contacts' },
  { type: 'follow_up', label: 'Follow-ups' }
]

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'date', label: 'Date' },
  { value: 'type', label: 'Type' }
]

export function SearchBar({ onSearch, onFilterChange, onSortChange, className }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('semantic')
  const [activeFilters, setActiveFilters] = useState<ActionType[]>([])
  const [activeSort, setActiveSort] = useState<SortBy>('type')
  const [showFilters, setShowFilters] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      if (query.trim()) {
        onSearch(query.trim(), searchMode)
      }
    }, 300)
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [query, searchMode, onSearch])

  const handleFilterToggle = useCallback(
    (type: ActionType) => {
      setActiveFilters((prev) => {
        const next = prev.includes(type) ? prev.filter((f) => f !== type) : [...prev, type]
        onFilterChange(next)
        return next
      })
    },
    [onFilterChange]
  )

  const handleSortChange = useCallback(
    (sort: SortBy) => {
      setActiveSort(sort)
      onSortChange(sort)
    },
    [onSortChange]
  )

  const clearSearch = useCallback(() => {
    setQuery('')
    onSearch('', searchMode)
  }, [onSearch, searchMode])

  return (
    <div className={cn('space-y-3', className)}>
      {/* Search Input Row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages..."
            className="pl-9 pr-9 bg-background"
          />
          {query && (
            <button
              onClick={clearSearch}
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Search Mode Toggle */}
        <Button
          variant={searchMode === 'semantic' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setSearchMode((prev) => (prev === 'fts' ? 'semantic' : 'fts'))}
          className="gap-1.5"
        >
          <Sparkles className="w-4 h-4" />
          <span className="hidden sm:inline">AI</span>
        </Button>

        {/* Filter Toggle */}
        <Button
          variant={showFilters ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setShowFilters((prev) => !prev)}
        >
          <SortAsc className="w-4 h-4" />
        </Button>
      </div>

      {/* Filters Row */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Type Filters */}
          <div className="flex items-center gap-1.5">
            {FILTER_OPTIONS.map((opt) => (
              <Badge
                key={opt.type}
                variant={activeFilters.includes(opt.type) ? 'default' : 'outline'}
                className="cursor-pointer select-none"
                onClick={() => handleFilterToggle(opt.type)}
              >
                {opt.label}
              </Badge>
            ))}
          </div>

          <div className="w-px h-5 bg-border" />

          {/* Sort Options */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Sort:</span>
            {SORT_OPTIONS.map((opt) => (
              <Badge
                key={opt.value}
                variant={activeSort === opt.value ? 'default' : 'outline'}
                className="cursor-pointer select-none"
                onClick={() => handleSortChange(opt.value)}
              >
                {opt.label}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Active Search Indicator */}
      {query && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            Searching with {searchMode === 'semantic' ? 'AI similarity' : 'full-text'} for:
          </span>
          <span className="font-medium text-foreground">&ldquo;{query}&rdquo;</span>
        </div>
      )}
    </div>
  )
}
