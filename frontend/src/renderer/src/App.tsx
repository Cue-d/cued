import { useEffect } from 'react'
import { useSyncStatus } from '@/hooks'
import { ViewProvider } from './contexts/ViewContext'
import { ViewContainer } from './components/Navigation/ViewContainer'
import { FloatingNavigationPill } from './components/Navigation/FloatingNavigationPill'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './components/ui/empty'
import { Spinner } from './components/ui/spinner'

function App() {
  const { isInitialSyncing } = useSyncStatus()

  // Enable dark mode on mount
  useEffect(() => {
    document.documentElement.classList.add('dark')
  }, [])

  // Show full-screen loading during initial sync
  if (isInitialSyncing) {
    return (
      <Empty className="w-full h-screen">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Syncing Messages</EmptyTitle>
          <EmptyDescription>This may take a moment.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ViewProvider>
      <div className="relative w-full h-screen flex overflow-hidden bg-imessage-window-bg">
        <ViewContainer />
        <FloatingNavigationPill />
      </div>
    </ViewProvider>
  )
}

export default App
