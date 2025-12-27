export interface Message {
  id: string
  text: string
  isSent: boolean
  timestamp: Date
  isLink?: boolean
}

export interface Conversation {
  id: string
  name: string
  avatar?: string
  initials?: string
  isGroup?: boolean
  groupAvatars?: string[]
  lastMessage: string
  timestamp: Date
  messages: Message[]
}

export const formatTimestamp = (date: Date): string => {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days === 0) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } else if (days === 1) {
    return 'Yesterday'
  } else if (days < 7) {
    return date.toLocaleDateString([], { weekday: 'short' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export const formatMessageTime = (date: Date): string => {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export const formatDateDivider = (date: Date): string => {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

const today = new Date()
const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)

export const conversations: Conversation[] = [
  {
    id: '1',
    name: 'Musa Shabazz',
    initials: 'MS',
    lastMessage: 'What ramen place',
    timestamp: new Date(today.setHours(10, 46)),
    messages: [
      { id: '1', text: 'Asking Casey', isSent: true, timestamp: new Date(yesterday.setHours(19, 58)) },
      { id: '2', text: 'Casey down, also asked sai', isSent: true, timestamp: new Date(yesterday.setHours(19, 58)) },
      { id: '3', text: 'Oh yeah Philips away', isSent: false, timestamp: new Date(yesterday.setHours(19, 59)) },
      { id: '4', text: "They're skiing", isSent: false, timestamp: new Date(yesterday.setHours(19, 59)) },
      { id: '5', text: 'Dinner at 7?', isSent: true, timestamp: new Date(yesterday.setHours(20, 0)) },
      { id: '6', text: 'Can send spot later', isSent: true, timestamp: new Date(yesterday.setHours(20, 0)) },
      { id: '7', text: 'Ramen tomo?', isSent: true, timestamp: new Date(today.setHours(0, 15)) },
      { id: '8', text: '7pm?', isSent: true, timestamp: new Date(today.setHours(0, 15)) },
      { id: '9', text: "Yea let's do it", isSent: false, timestamp: new Date(today.setHours(9, 31)) },
      { id: '10', text: "Btw if it's snowing a lot my moms not letting me out", isSent: false, timestamp: new Date(today.setHours(9, 32)) },
      { id: '11', text: 'What ramen place', isSent: false, timestamp: new Date(today.setHours(9, 33)) },
      { id: '12', text: 'Ippudo?', isSent: true, timestamp: new Date(today.setHours(10, 46)) },
    ]
  },
  {
    id: '2',
    name: 'Steven Cui',
    initials: 'SC',
    lastMessage: 'Smalls, Vanguard, Dizzy\'s, Smoke, Birdland, Blue Note',
    timestamp: new Date(today.setHours(10, 58)),
    messages: [
      { id: '1', text: 'Jazz clubs tonight?', isSent: true, timestamp: new Date(today.setHours(10, 30)) },
      { id: '2', text: "Smalls, Vanguard, Dizzy's, Smoke, Birdland, Blue Note", isSent: false, timestamp: new Date(today.setHours(10, 58)) },
    ]
  },
  {
    id: '3',
    name: 'Hannah Gao',
    initials: 'HG',
    lastMessage: 'Came across this and was thinking of our convo!',
    timestamp: new Date(today.setHours(10, 48)),
    messages: [
      { id: '1', text: 'Came across this and was thinking of our convo!', isSent: false, timestamp: new Date(today.setHours(10, 48)) },
    ]
  },
  {
    id: '4',
    name: 'Jay, Aaron, Daniel, Emma',
    initials: 'JA',
    isGroup: true,
    lastMessage: 'Zoom?',
    timestamp: new Date(today.setHours(10, 46)),
    messages: [
      { id: '1', text: 'Zoom?', isSent: false, timestamp: new Date(today.setHours(10, 46)) },
    ]
  },
  {
    id: '5',
    name: 'Tejas',
    initials: 'T',
    lastMessage: 'With my fam but might have sm time to deviate',
    timestamp: new Date(today.setHours(0, 17)),
    messages: [
      { id: '1', text: 'You around this weekend?', isSent: true, timestamp: new Date(yesterday.setHours(23, 0)) },
      { id: '2', text: 'With my fam but might have sm time to deviate', isSent: false, timestamp: new Date(today.setHours(0, 17)) },
    ]
  },
  {
    id: '6',
    name: 'Bruce Tang',
    initials: 'BT',
    lastMessage: 'Missed your call, was on dnd',
    timestamp: yesterday,
    messages: [
      { id: '1', text: 'Missed your call, was on dnd', isSent: false, timestamp: yesterday },
    ]
  },
  {
    id: '7',
    name: 'Maybe: Simon Farruqui',
    initials: 'SF',
    lastMessage: 'Great to hang and get home safe',
    timestamp: yesterday,
    messages: [
      { id: '1', text: 'Great to hang and get home safe', isSent: false, timestamp: yesterday },
    ]
  },
  {
    id: '8',
    name: 'Kavita & Nik Bafana',
    initials: 'KB',
    lastMessage: 'Going to bed',
    timestamp: yesterday,
    messages: [
      { id: '1', text: 'Going to bed', isSent: false, timestamp: yesterday },
    ]
  },
]
