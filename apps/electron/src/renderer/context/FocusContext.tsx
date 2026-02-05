import { createContext, useCallback, useContext, useRef, useState } from "react"
import type { ReactNode, RefObject } from "react"

/**
 * Focus zone identifiers - ordered for Tab navigation
 */
export type FocusZoneId = 'sidebar' | 'list' | 'detail'

const ZONE_ORDER: FocusZoneId[] = ['sidebar', 'list', 'detail']

interface FocusZone {
  id: FocusZoneId
  ref: RefObject<HTMLElement>
  focusFirst?: () => void
}

interface FocusContextValue {
  currentZone: FocusZoneId | null
  registerZone: (zone: FocusZone) => void
  unregisterZone: (id: FocusZoneId) => void
  focusZone: (id: FocusZoneId) => void
  focusNextZone: () => void
  focusPreviousZone: () => void
  isZoneFocused: (id: FocusZoneId) => boolean
}

const FocusContext = createContext<FocusContextValue | null>(null)

export function FocusProvider({ children }: { children: ReactNode }): ReactNode {
  const [currentZone, setCurrentZone] = useState<FocusZoneId | null>(null)
  const zonesRef = useRef<Map<FocusZoneId, FocusZone>>(new Map())

  const registerZone = useCallback((zone: FocusZone) => {
    zonesRef.current.set(zone.id, zone)
  }, [])

  const unregisterZone = useCallback((id: FocusZoneId) => {
    zonesRef.current.delete(id)
  }, [])

  const focusZone = useCallback((id: FocusZoneId) => {
    const zone = zonesRef.current.get(id)
    if (zone) {
      setCurrentZone(id)
      if (zone.focusFirst) {
        zone.focusFirst()
      } else if (zone.ref.current) {
        zone.ref.current.focus()
      }
    }
  }, [])

  const focusNextZone = useCallback(() => {
    const currentIndex = currentZone ? ZONE_ORDER.indexOf(currentZone) : -1
    const nextIndex = (currentIndex + 1) % ZONE_ORDER.length
    focusZone(ZONE_ORDER[nextIndex])
  }, [currentZone, focusZone])

  const focusPreviousZone = useCallback(() => {
    const currentIndex = currentZone ? ZONE_ORDER.indexOf(currentZone) : 0
    const prevIndex = (currentIndex - 1 + ZONE_ORDER.length) % ZONE_ORDER.length
    focusZone(ZONE_ORDER[prevIndex])
  }, [currentZone, focusZone])

  const isZoneFocused = useCallback((id: FocusZoneId) => {
    return currentZone === id
  }, [currentZone])

  const value: FocusContextValue = {
    currentZone,
    registerZone,
    unregisterZone,
    focusZone,
    focusNextZone,
    focusPreviousZone,
    isZoneFocused,
  }

  return (
    <FocusContext.Provider value={value}>
      {children}
    </FocusContext.Provider>
  )
}

export function useFocusContext(): FocusContextValue {
  const context = useContext(FocusContext)
  if (!context) {
    throw new Error('useFocusContext must be used within a FocusProvider')
  }
  return context
}
