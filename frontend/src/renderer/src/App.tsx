import { useState, useEffect } from 'react'
import ConversationList from './components/ConversationList'
import MessageThread from './components/MessageThread'
import ThemeToggle from './components/ThemeToggle'
import { conversations } from '@/data/mockData'

function App(): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(conversations[0]?.id || null)
  const selectedConversation = conversations.find((c) => c.id === selectedId) || null
  const [isDark, setIsDark] = useState(true)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  return (
    <div className="relative w-full h-screen flex bg-imessage-window-bg">
      <div className="absolute top-3 right-3 z-10">
        <ThemeToggle isDark={isDark} onToggle={() => setIsDark(!isDark)} />
      </div>
      <ConversationList
        conversations={conversations}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <MessageThread conversation={selectedConversation} />
    </div>
  )
}

export default App
