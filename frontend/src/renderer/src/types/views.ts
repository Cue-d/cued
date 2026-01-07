export type ViewType = 'action-queue' | 'agent'

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
  agent: {
    id: 'agent',
    label: 'Agent',
    icon: 'MessageSquare',
    shortcut: '⌘2'
  }
}

export const VIEW_ORDER: ViewType[] = ['action-queue', 'agent']
