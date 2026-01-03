import { useState, useEffect } from 'react'
import ChatList from './components/ChatList'
import MessageThread from './components/MessageThread'
import ThemeToggle from './components/ThemeToggle'
import { CommandMenu } from './components/CommandMenu'
import { useChats, useMessages } from '@/hooks'

function App() {
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
