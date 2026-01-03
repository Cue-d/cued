import { useState, useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import ChatList from './components/ChatList'
import MessageThread from './components/MessageThread'
import ThemeToggle from './components/ThemeToggle'
import { CommandMenu } from './components/CommandMenu'
import { useChats, useMessages, useSyncStatus } from '@/hooks'

function App() {
  const { isInitialSyncing } = useSyncStatus()

  const {
    chats,
    setChats,
    selectedId,
    setSelectedId,
    loading,
    loadingMore,
    hasMore,
    handleLoadMore
  } = useChats()

  const { handleSendMessage } = useMessages({
    selectedId,
    setChats
  })

  const [isDark, setIsDark] = useState(true)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  const selectedChat = chats.find((c) => c.id === selectedId) || null

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

  if (loading) {
    return (
      <div className="w-full h-screen flex items-center justify-center bg-imessage-window-bg">
        <span className="text-muted-foreground">Loading...</span>
      </div>
    )
  }

  return (
    <div className="relative w-full h-screen flex overflow-hidden bg-imessage-window-bg">
      <CommandMenu isDark={isDark} onToggleTheme={() => setIsDark(!isDark)} />
      <div className="absolute top-3 right-3 z-10">
        <ThemeToggle isDark={isDark} onToggle={() => setIsDark(!isDark)} />
      </div>
      <ChatList
        chats={chats}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onLoadMore={handleLoadMore}
        hasMore={hasMore}
        loading={loadingMore}
      />
      <MessageThread chat={selectedChat} onSendMessage={handleSendMessage} />
    </div>
  )
}

export default App
