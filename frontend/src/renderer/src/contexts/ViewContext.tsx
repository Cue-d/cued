import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import type { ViewType } from '@/types/views'
import { VIEW_ORDER } from '@/types/views'

interface ViewContextType {
  currentView: ViewType
  setView: (view: ViewType) => void
  navigateNext: () => void
  navigatePrevious: () => void
}

const ViewContext = createContext<ViewContextType | undefined>(undefined)

export function ViewProvider({ children }: { children: React.ReactNode }) {
  const [currentView, setCurrentView] = useState<ViewType>('action-queue')

  const setView = useCallback((view: ViewType) => {
    setCurrentView(view)
  }, [])

  const navigateNext = useCallback(() => {
    setCurrentView((prev) => {
      const currentIndex = VIEW_ORDER.indexOf(prev)
      const nextIndex = (currentIndex + 1) % VIEW_ORDER.length
      return VIEW_ORDER[nextIndex]
    })
  }, [])

  const navigatePrevious = useCallback(() => {
    setCurrentView((prev) => {
      const currentIndex = VIEW_ORDER.indexOf(prev)
      const prevIndex = currentIndex === 0 ? VIEW_ORDER.length - 1 : currentIndex - 1
      return VIEW_ORDER[prevIndex]
    })
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + number keys
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key)
        if (num >= 1 && num <= 4) {
          e.preventDefault()
          const viewIndex = num - 1
          if (viewIndex < VIEW_ORDER.length) {
            setCurrentView(VIEW_ORDER[viewIndex])
          }
        }
      }

      // Arrow keys for navigation (when not typing)
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      if (e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        navigatePrevious()
      } else if (e.key === 'ArrowRight' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        navigateNext()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigateNext, navigatePrevious])

  return (
    <ViewContext.Provider value={{ currentView, setView, navigateNext, navigatePrevious }}>
      {children}
    </ViewContext.Provider>
  )
}

export function useView() {
  const context = useContext(ViewContext)
  if (context === undefined) {
    throw new Error('useView must be used within a ViewProvider')
  }
  return context
}

