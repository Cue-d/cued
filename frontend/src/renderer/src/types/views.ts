export type ViewType = 'action-queue' | 'chat'

export interface ViewConfig {
  id: ViewType
  label: string
  icon: string // Icon name from lucide-react
  shortcut?: string // Keyboard shortcut description
}

export const VIEWS: Record<ViewType, ViewConfig> = {
  'action-queue': {
    id: 'action-queue',
    label: 'Actions',
    icon: 'Target',
    shortcut: '⌘1'
  },
  chat: {
    id: 'chat',
    label: 'Chat',
    icon: 'MessageSquare',
    shortcut: '⌘2'
  }
}

export const VIEW_ORDER: ViewType[] = ['action-queue', 'chat']
