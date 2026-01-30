"use client";

import { useState, useCallback, useRef, useEffect } from "react"

export interface MentionState {
  /** Whether the mention picker is active/visible */
  active: boolean
  /** Search query text after the @ symbol */
  query: string
  /** Cursor position where @ was typed */
  triggerIndex: number
  /** Anchor rectangle for positioning the picker */
  anchorRect: DOMRect | null
}

export interface UseMentionReturn extends MentionState {
  /** Activate the mention picker at given position */
  activate: (triggerIndex: number, anchorRect: DOMRect) => void
  /** Update the search query */
  updateQuery: (query: string) => void
  /** Close the picker without selecting */
  close: () => void
  /** Reset all state */
  reset: () => void
  /** Ref to track if picker was just closed (to prevent immediate reopen) */
  justClosedRef: React.RefObject<boolean>
}

const initialState: MentionState = {
  active: false,
  query: "",
  triggerIndex: -1,
  anchorRect: null,
}

export function useMention(): UseMentionReturn {
  const [state, setState] = useState<MentionState>(initialState)
  const justClosedRef = useRef(false)
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current)
      }
    }
  }, [])

  const activate = useCallback((triggerIndex: number, anchorRect: DOMRect) => {
    setState({
      active: true,
      query: "",
      triggerIndex,
      anchorRect,
    })
  }, [])

  const updateQuery = useCallback((query: string) => {
    setState((prev) => ({
      ...prev,
      query,
    }))
  }, [])

  const close = useCallback(() => {
    justClosedRef.current = true
    setState(initialState)
    // Clear any existing timeout
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current)
    }
    // Reset justClosed flag after a short delay
    closeTimeoutRef.current = setTimeout(() => {
      justClosedRef.current = false
    }, 100)
  }, [])

  const reset = useCallback(() => {
    setState(initialState)
  }, [])

  return {
    ...state,
    activate,
    updateQuery,
    close,
    reset,
    justClosedRef,
  }
}
