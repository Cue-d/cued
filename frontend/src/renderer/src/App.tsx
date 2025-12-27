import { useState, useEffect } from 'react'
import ConversationList from './components/ConversationList'
import MessageThread from './components/MessageThread'
import ThemeToggle from './components/ThemeToggle'
import { fetchConversations, fetchMessages, ConversationResponse, MessageResponse } from './api/client'
import { Conversation, Message } from '@/data/mockData'

function App(): React.JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isDark, setIsDark] = useState(true)
  const [loading, setLoading] = useState(true)

  // Convert API response to UI model
  const toConversation = (c: ConversationResponse, messages: Message[] = []): Conversation => ({
    id: String(c.id),
    name: c.name,
    initials: c.name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .slice(0, 2)
      .toUpperCase(),
    isGroup: c.is_group || c.handle_ids.length > 1,
    lastMessage: c.last_message || '',
    timestamp: new Date(c.last_message_date * 1000),
    messages
  })

  const toMessage = (m: MessageResponse): Message => ({
    id: String(m.id),
    text: m.text || '',
    isSent: m.is_from_me,
    timestamp: new Date(m.date * 1000)
  })

  // Load conversations on mount
  useEffect(() => {
    fetchConversations(50)
      .then((data) => {
        const convos = data.map((c) => toConversation(c))
        setConversations(convos)
        if (convos.length > 0 && !selectedId) {
          setSelectedId(convos[0].id)
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  // Load messages when selection changes
  useEffect(() => {
    if (!selectedId) return

    fetchMessages(Number(selectedId), 100)
      .then((data) => {
        const messages = data.map(toMessage).reverse() // API returns desc, we want asc
        setConversations((prev) =>
          prev.map((c) => (c.id === selectedId ? { ...c, messages } : c))
        )
      })
      .catch(console.error)
  }, [selectedId])

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
