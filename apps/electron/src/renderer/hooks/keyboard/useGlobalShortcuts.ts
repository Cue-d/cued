import { useEffect, useRef } from "react"

import { isMac } from "../../lib/platform"

interface Shortcut {
  key: string
  action: () => void
  alt?: boolean
  cmd?: boolean
  shift?: boolean
  when?: () => boolean
}

interface UseGlobalShortcutsOptions {
  disabled?: boolean
  shortcuts: Shortcut[]
}

/**
 * Registers global keyboard shortcuts that work anywhere in the app.
 * Uses Cmd on Mac, Ctrl on Windows/Linux for the cmd modifier.
 */
export function useGlobalShortcuts({ shortcuts, disabled = false }: UseGlobalShortcutsOptions): void {
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts

  const disabledRef = useRef(disabled)
  disabledRef.current = disabled

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (disabledRef.current) return

      const target = e.target as HTMLElement
      const isInput = target.tagName === 'INPUT' ||
                      target.tagName === 'TEXTAREA' ||
                      target.isContentEditable

      const cmdKeyPressed = isMac ? e.metaKey : e.ctrlKey

      for (const shortcut of shortcutsRef.current) {
        // Only check modifiers that are explicitly required
        const cmdMatch = !shortcut.cmd || cmdKeyPressed
        const shiftMatch = !shortcut.shift || e.shiftKey
        const altMatch = !shortcut.alt || e.altKey
        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase()

        if (!cmdMatch || !shiftMatch || !altMatch || !keyMatch) continue

        const keyLower = e.key.toLowerCase()
        const isTabOrEscape = keyLower === 'tab' || keyLower === 'escape'
        if (isInput && !shortcut.cmd && !isTabOrEscape) continue

        if (shortcut.when && !shortcut.when()) continue

        e.preventDefault()
        e.stopPropagation()
        shortcut.action()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])
}

export function shortcut(
  key: string,
  action: () => void,
  options?: { alt?: boolean; cmd?: boolean; shift?: boolean; when?: () => boolean }
): Shortcut {
  return { key, action, ...options }
}
