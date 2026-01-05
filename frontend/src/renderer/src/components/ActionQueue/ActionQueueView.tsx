import { AlertCircle, Inbox, RefreshCw } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { searchMessages, semanticSearch } from '@/api/actions'
import type { ActionType, SearchResultResponse, SwipeDirection } from '@/data/types'
import { useActions } from '@/hooks'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { CardStack } from './CardStack'
import { SearchBar } from './SearchBar'
import { Spinner } from '../ui/spinner'

type SortBy = 'priority' | 'date' | 'type'

export function ActionQueueView() {
  const { actions, loading, error, handleSwipe, refresh } = useActions()

  // Local state for filtering/sorting
  const [activeFilters, setActiveFilters] = useState<ActionType[]>([])
  const [sortBy, setSortBy] = useState<SortBy>('priority')
  const [isSearching, setIsSearching] = useState(false)

  // Handle search (currently just updates query state, could integrate with action filtering)
  const handleSearch = useCallback(async (query: string, mode: 'fts' | 'semantic') => {
    console.log(`[ActionQueueView] handleSearch called - query: "${query}", mode: ${mode}`)
    if (!query) {
      console.log('[ActionQueueView] Empty query, skipping search')
      return
    }

    setIsSearching(true)
    try {
      // Execute search (results could be used to highlight/filter actions)
      let results: SearchResultResponse[] = []
      if (mode === 'semantic') {
        console.log('[ActionQueueView] Calling semanticSearch...')
        results = await semanticSearch(query, 20)
      } else {
        console.log('[ActionQueueView] Calling searchMessages...')
        results = await searchMessages(query, 50)
      }
      console.log(
        `[ActionQueueView] Search complete - got ${results?.length ?? 0} results:`,
        results
      )
      // For now, just log - in future could filter actions by search results
    } catch (err) {
      console.error('[ActionQueueView] Search failed:', err)
    } finally {
      setIsSearching(false)
    }
  }, [])

  // Filter and sort actions
  const filteredActions = useMemo(() => {
    let result = [...actions]

    // Apply type filters
    if (activeFilters.length > 0) {
      result = result.filter((a) => activeFilters.includes(a.type))
    }

    // Apply sorting
    result.sort((a, b) => {
      switch (sortBy) {
        case 'priority':
          return b.priority - a.priority
        case 'date':
          return b.created_at - a.created_at
        case 'type':
          return a.type.localeCompare(b.type)
        default:
          return 0
      }
    })

    return result
  }, [actions, activeFilters, sortBy])

  // Wrap handleSwipe for CardStack
  const onSwipe = useCallback(
    async (
      actionId: number,
      direction: SwipeDirection,
      responseText?: string,
      snoozeMinutes?: number
    ) => {
      await handleSwipe(actionId, direction, responseText, snoozeMinutes)
    },
    [handleSwipe]
  )

  if (loading) {
    return (
      <div className="w-full h-full bg-imessage-window-bg">
        <Empty className="border-0">
          <EmptyMedia>
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Loading Actions</EmptyTitle>
          <EmptyDescription>Getting your pending items...</EmptyDescription>
        </Empty>
      </div>
    )
  }

  if (error) {
    return (
      <div className="w-full h-full bg-imessage-window-bg">
        <Empty className="border-0">
          <EmptyMedia variant="icon">
            <AlertCircle className="w-6 h-6" />
          </EmptyMedia>
          <EmptyTitle>Something went wrong</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
          <button
            onClick={refresh}
            className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
          >
            Try Again
          </button>
        </Empty>
      </div>
    )
  }

  return (
    <div className="w-full h-full flex flex-col bg-imessage-window-bg">
      {/* Header */}
      <div className="shrink-0 px-6 pt-12 pb-4 border-b border-border bg-imessage-header-bg">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Inbox className="w-6 h-6 text-muted-foreground" />
            <h1 className="text-xl font-semibold text-secondary-foreground">Action Queue</h1>
          </div>
          <button
            type="button"
            onClick={refresh}
            className="p-2 rounded-lg hover:bg-muted transition-colors"
            title="Refresh actions"
          >
            <RefreshCw
              className={`w-5 h-5 text-muted-foreground ${isSearching ? 'animate-spin' : ''}`}
            />
          </button>
        </div>

        {/* Search Bar */}
        <SearchBar
          onSearch={handleSearch}
          onFilterChange={setActiveFilters}
          onSortChange={setSortBy}
        />
      </div>

      {/* Card Stack */}
      <div className="flex-1 overflow-hidden relative">
        <CardStack actions={filteredActions} onSwipe={onSwipe} />
      </div>
    </div>
  )
}
