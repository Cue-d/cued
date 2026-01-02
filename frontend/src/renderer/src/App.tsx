import { useState, useEffect } from 'react'
import ConversationList from './components/ConversationList'
import MessageThread from './components/MessageThread'
import ThemeToggle from './components/ThemeToggle'
import { CommandMenu } from './components/CommandMenu'
import { useConversations, useMessages } from '@/hooks'

function App() {
  const {
    conversations,
    setConversations,
    selectedId,
    setSelectedId,
    loading,
    loadingMore,
    hasMore,
    handleLoadMore
  } = useConversations()

  const { handleSendMessage } = useMessages({
    selectedId,
    setConversations
  })

  const [isDark, setIsDark] = useState(true)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  const selectedConversation = conversations.find((c) => c.id === selectedId) || null

  if (loading) {
    return (
      <div className="w-full h-screen flex items-center justify-center bg-imessage-window-bg">
        <span className="text-muted-foreground">Loading...</span>
      </div>
    )
  }

  return (
    <div className="relative w-full h-screen flex bg-imessage-window-bg">
      <CommandMenu isDark={isDark} onToggleTheme={() => setIsDark(!isDark)} />
      <div className="absolute top-3 right-3 z-10">
        <ThemeToggle isDark={isDark} onToggle={() => setIsDark(!isDark)} />
      </div>
      <ConversationList
        conversations={conversations}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onLoadMore={handleLoadMore}
        hasMore={hasMore}
        loading={loadingMore}
      />
      <MessageThread conversation={selectedConversation} onSendMessage={handleSendMessage} />
    </div>
  )
}

export default App
