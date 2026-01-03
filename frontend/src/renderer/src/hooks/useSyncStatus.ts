import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchSyncStatus, SyncStatusResponse } from '@/api/client'

interface UseSyncStatusReturn {
  syncStatus: SyncStatusResponse | null
  isInitialSyncing: boolean
  isSyncing: boolean
  error: string | null
}

export function useSyncStatus(pollInterval = 1000): UseSyncStatusReturn {
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const initialSyncDone = useRef(false)

  const poll = useCallback(async () => {
    try {
      const status = await fetchSyncStatus()
      setSyncStatus(status)
      setError(null)
      // Stop polling once initial sync completes
      if (status.initial_sync_complete) {
        initialSyncDone.current = true
      }
      return status.initial_sync_complete
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch sync status')
      return false
    }
  }, [])

  useEffect(() => {
    // Stop polling once initial sync is complete
    if (initialSyncDone.current) {
      return
    }

    let mounted = true
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const pollLoop = async () => {
      if (!mounted || initialSyncDone.current) return

      const complete = await poll()

      // Schedule next poll only if not complete and still mounted
      if (mounted && !complete) {
        timeoutId = setTimeout(pollLoop, pollInterval)
      }
    }

    // Initial fetch
    pollLoop()

    return () => {
      mounted = false
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [pollInterval, poll])

  return {
    syncStatus,
    isInitialSyncing: syncStatus ? !syncStatus.initial_sync_complete : true,
    isSyncing: syncStatus?.is_syncing ?? false,
    error
  }
}
