export type ViewType = 'action-queue' | 'messages' | 'contacts' | 'settings'

export interface ViewConfig {
  id: ViewType
  label: string
  icon: string // Icon name from lucide-react
  shortcut?: string // Keyboard shortcut description
}

export const VIEWS: Record<ViewType, ViewConfig> = {
  'action-queue': {
    id: 'action-queue',
    label: 'Action Queue',
    icon: 'Target',
    shortcut: '⌘1'
  },
  messages: {
    id: 'messages',
    label: 'Messages',
    icon: 'MessageSquare',
    shortcut: '⌘2'
  },
  contacts: {
    id: 'contacts',
    label: 'Contacts',
    icon: 'Users',
    shortcut: '⌘3'
  },
  settings: {
    id: 'settings',
    label: 'Settings',
    icon: 'Settings',
    shortcut: '⌘4'
  }
}

export const VIEW_ORDER: ViewType[] = ['action-queue', 'messages', 'contacts', 'settings']

