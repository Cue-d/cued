import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSyncStatus } from '@/hooks'
import { ActionQueueView } from './components/ActionQueue'
import { CommandMenu } from './components/CommandMenu'
import ThemeToggle from './components/ThemeToggle'

function App() {
  const { isInitialSyncing } = useSyncStatus()
  const [isDark, setIsDark] = useState(true)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  // Show full-screen loading during initial sync
  if (isInitialSyncing) {
    return (
      <div className="w-full h-screen flex flex-col items-center justify-center bg-imessage-window-bg gap-4">
        <RefreshCw className="w-8 h-8 text-primary animate-spin" />
        <div className="flex flex-col items-center gap-1">
          <span className="text-foreground font-medium">Syncing Messages</span>
          <span className="text-sm text-muted-foreground">
            This may take a moment on first launch...
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="relative w-full h-screen flex overflow-hidden bg-imessage-window-bg">
      <CommandMenu />
      <div className="absolute top-3 right-3 z-10">
        <ThemeToggle isDark={isDark} onToggle={() => setIsDark(!isDark)} />
      </div>
      <ActionQueueView />
    </div>
  )
}

export default App
