import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSyncStatus } from '@/hooks/useSyncStatus'
import * as client from '@/api/client'

vi.mock('@/api/client', () => ({
  fetchSyncStatus: vi.fn()
}))

const mockFetchSyncStatus = vi.mocked(client.fetchSyncStatus)

describe('useSyncStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetchSyncStatus.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns initial state before first fetch completes', () => {
    mockFetchSyncStatus.mockImplementation(() => new Promise(() => {})) // Never resolves

    const { result } = renderHook(() => useSyncStatus())

    expect(result.current.syncStatus).toBeNull()
    expect(result.current.isInitialSyncing).toBe(true)
    expect(result.current.isSyncing).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('fetches sync status on mount', async () => {
    mockFetchSyncStatus.mockResolvedValue({
      is_syncing: true,
      initial_sync_complete: false,
      last_sync_at: null,
      last_sync_duration: null,
      last_error: null
    })

    const { result } = renderHook(() => useSyncStatus())

    // Flush the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1)
    expect(result.current.syncStatus?.is_syncing).toBe(true)
    expect(result.current.isInitialSyncing).toBe(true)
    expect(result.current.isSyncing).toBe(true)
  })

  it('continues polling while initial sync is incomplete', async () => {
    mockFetchSyncStatus.mockResolvedValue({
      is_syncing: true,
      initial_sync_complete: false,
      last_sync_at: null,
      last_sync_duration: null,
      last_error: null
    })

    renderHook(() => useSyncStatus(1000))

    // Wait for initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1)

    // Advance time to trigger next poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(2)

    // Advance again
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(3)
  })

  it('stops polling when initial sync is complete', async () => {
    mockFetchSyncStatus.mockResolvedValue({
      is_syncing: false,
      initial_sync_complete: true,
      last_sync_at: Date.now(),
      last_sync_duration: 1500,
      last_error: null
    })

    const { result } = renderHook(() => useSyncStatus(1000))

    // Wait for initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1)
    expect(result.current.isInitialSyncing).toBe(false)

    // Advance time - should NOT trigger more polls
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1)
  })

  it('updates state when sync completes mid-polling', async () => {
    // First call: syncing in progress
    mockFetchSyncStatus
      .mockResolvedValueOnce({
        is_syncing: true,
        initial_sync_complete: false,
        last_sync_at: null,
        last_sync_duration: null,
        last_error: null
      })
      // Second call: sync complete
      .mockResolvedValueOnce({
        is_syncing: false,
        initial_sync_complete: true,
        last_sync_at: Date.now(),
        last_sync_duration: 2000,
        last_error: null
      })

    const { result } = renderHook(() => useSyncStatus(1000))

    // Wait for first fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.isInitialSyncing).toBe(true)
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1)

    // Advance to trigger second poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.isInitialSyncing).toBe(false)
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(2)

    // Should stop polling now
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(2)
  })

  it('sets error state when fetch fails', async () => {
    mockFetchSyncStatus.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useSyncStatus())

    // Flush the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.error).toBe('Network error')
    expect(result.current.syncStatus).toBeNull()
    expect(result.current.isInitialSyncing).toBe(true)
  })

  it('clears error when subsequent fetch succeeds', async () => {
    mockFetchSyncStatus.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({
      is_syncing: false,
      initial_sync_complete: true,
      last_sync_at: Date.now(),
      last_sync_duration: 1000,
      last_error: null
    })

    const { result } = renderHook(() => useSyncStatus(1000))

    // Wait for first fetch to fail
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.error).toBe('Network error')

    // Advance to trigger retry
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.error).toBeNull()
    expect(result.current.syncStatus?.initial_sync_complete).toBe(true)
  })

  it('handles non-Error exceptions', async () => {
    mockFetchSyncStatus.mockRejectedValue('String error')

    const { result } = renderHook(() => useSyncStatus())

    // Flush the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.error).toBe('Failed to fetch sync status')
  })

  it('cleans up timer on unmount', async () => {
    mockFetchSyncStatus.mockResolvedValue({
      is_syncing: true,
      initial_sync_complete: false,
      last_sync_at: null,
      last_sync_duration: null,
      last_error: null
    })

    const { unmount } = renderHook(() => useSyncStatus(1000))

    // Wait for initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1)

    // Unmount the hook
    unmount()

    // Advance time - should NOT trigger more polls since unmounted
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1)
  })

  it('uses custom poll interval', async () => {
    mockFetchSyncStatus.mockResolvedValue({
      is_syncing: true,
      initial_sync_complete: false,
      last_sync_at: null,
      last_sync_duration: null,
      last_error: null
    })

    renderHook(() => useSyncStatus(500))

    // Wait for initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1)

    // At 500ms, should trigger second poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(2)

    // At 1000ms, should trigger third poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(mockFetchSyncStatus).toHaveBeenCalledTimes(3)
  })

  it('returns correct derived state values', async () => {
    const syncData = {
      is_syncing: true,
      initial_sync_complete: false,
      last_sync_at: 1704067200000,
      last_sync_duration: 1500,
      last_error: null
    }
    mockFetchSyncStatus.mockResolvedValue(syncData)

    const { result } = renderHook(() => useSyncStatus())

    // Flush the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.syncStatus).toEqual(syncData)
    expect(result.current.isInitialSyncing).toBe(true)
    expect(result.current.isSyncing).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('returns isSyncing as false when syncStatus is null', () => {
    mockFetchSyncStatus.mockImplementation(() => new Promise(() => {}))

    const { result } = renderHook(() => useSyncStatus())

    expect(result.current.isSyncing).toBe(false)
  })
})
