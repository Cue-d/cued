import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useActions } from '@/hooks/useActions'
import * as actionsApi from '@/api/actions'
import type { ActionResponse } from '@/api/actions'

vi.mock('@/api/actions', () => ({
  fetchActions: vi.fn(),
  fetchActionsCount: vi.fn(),
  swipeAction: vi.fn()
}))

const mockFetchActions = vi.mocked(actionsApi.fetchActions)
const mockFetchActionsCount = vi.mocked(actionsApi.fetchActionsCount)
const mockSwipeAction = vi.mocked(actionsApi.swipeAction)

const mockAction1: ActionResponse = {
  id: 1,
  type: 'respond_to_message',
  status: 'pending',
  priority: 90,
  chat_id: 1,
  person_id: 1,
  message_id: 100,
  payload: null,
  created_at: Date.now() - 3600000,
  remind_at: null,
  snoozed_until: null,
  completed_at: null,
  discarded_at: null,
  chat_name: 'Alex Chen',
  person_name: 'Alex Chen',
  message_text: 'Test message',
  message_timestamp: Date.now() - 3600000,
  recent_messages: []
}

const mockAction2: ActionResponse = {
  id: 2,
  type: 'respond_to_message',
  status: 'pending',
  priority: 85,
  chat_id: 2,
  person_id: 2,
  message_id: 200,
  payload: null,
  created_at: Date.now() - 7200000,
  remind_at: null,
  snoozed_until: null,
  completed_at: null,
  discarded_at: null,
  chat_name: 'Sarah Miller',
  person_name: 'Sarah Miller',
  message_text: 'Another message',
  message_timestamp: Date.now() - 7200000,
  recent_messages: []
}

describe('useActions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetchActions.mockReset()
    mockFetchActionsCount.mockReset()
    mockSwipeAction.mockReset()
    // Default count mock - returns 0 unless overridden
    mockFetchActionsCount.mockResolvedValue(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns initial loading state before first fetch completes', () => {
    mockFetchActions.mockImplementation(() => new Promise(() => {})) // Never resolves

    const { result } = renderHook(() => useActions())

    expect(result.current.loading).toBe(true)
    expect(result.current.actions).toEqual([])
    expect(result.current.currentAction).toBeNull()
    expect(result.current.remainingCount).toBe(0)
    expect(result.current.error).toBeNull()
  })

  it('fetches actions on mount', async () => {
    mockFetchActions.mockResolvedValue([mockAction1, mockAction2])
    mockFetchActionsCount.mockResolvedValue(2)

    const { result } = renderHook(() => useActions())

    // Flush the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockFetchActions).toHaveBeenCalledTimes(1)
    expect(mockFetchActions).toHaveBeenCalledWith('pending', 50, undefined)
    expect(result.current.loading).toBe(false)
    expect(result.current.actions).toEqual([mockAction1, mockAction2])
    expect(result.current.currentAction).toEqual(mockAction1)
    expect(result.current.totalCount).toBe(2)
  })

  it('falls back to mock data when API fails', async () => {
    mockFetchActions.mockRejectedValue(new Error('Network error'))
    mockFetchActionsCount.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useActions())

    // Flush the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.actions.length).toBeGreaterThan(0)
    expect(result.current.currentAction).not.toBeNull()
    // Mock data fallback doesn't set totalCount, so check actions.length
    expect(result.current.actions.length).toBeGreaterThan(0)
  })

  it('falls back to mock data when API returns empty array', async () => {
    mockFetchActions.mockResolvedValue([])
    mockFetchActionsCount.mockResolvedValue(0)

    const { result } = renderHook(() => useActions())

    // Flush the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.actions.length).toBeGreaterThan(0)
    expect(result.current.currentAction).not.toBeNull()
    // Mock data fallback doesn't set totalCount, so check actions.length
    expect(result.current.actions.length).toBeGreaterThan(0)
  })

  it('handleSwipe removes action from list on success', async () => {
    mockFetchActions.mockResolvedValue([mockAction1, mockAction2])
    mockFetchActionsCount.mockResolvedValue(2)
    mockSwipeAction.mockResolvedValue(mockAction1)

    const { result } = renderHook(() => useActions())

    // Wait for initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.totalCount).toBe(2)

    // Swipe the first action
    await act(async () => {
      await result.current.handleSwipe(1, 'right', 'Response text')
    })

    expect(mockSwipeAction).toHaveBeenCalledWith(1, 'right', 'Response text', undefined)
    expect(result.current.totalCount).toBe(1)
    expect(result.current.actions).toEqual([mockAction2])
    expect(result.current.currentAction).toEqual(mockAction2)
  })

  it('handleSwipe removes action from list even on API failure (mock mode)', async () => {
    mockFetchActions.mockResolvedValue([mockAction1, mockAction2])
    mockFetchActionsCount.mockResolvedValue(2)
    mockSwipeAction.mockRejectedValue(new Error('API error'))

    const { result } = renderHook(() => useActions())

    // Wait for initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.totalCount).toBe(2)

    // Swipe the first action (should still remove it locally)
    await act(async () => {
      await result.current.handleSwipe(1, 'left')
    })

    expect(mockSwipeAction).toHaveBeenCalledWith(1, 'left', undefined, undefined)
    expect(result.current.totalCount).toBe(1)
    expect(result.current.actions).toEqual([mockAction2])
    expect(result.current.currentAction).toEqual(mockAction2)
  })

  it('handleSwipe passes snooze minutes for up swipe', async () => {
    mockFetchActions.mockResolvedValue([mockAction1])
    mockSwipeAction.mockResolvedValue(mockAction1)

    const { result } = renderHook(() => useActions())

    // Wait for initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // Swipe up with snooze
    await act(async () => {
      await result.current.handleSwipe(1, 'up', undefined, 60)
    })

    expect(mockSwipeAction).toHaveBeenCalledWith(1, 'up', undefined, 60)
  })

  it('currentAction returns first action', async () => {
    mockFetchActions.mockResolvedValue([mockAction1, mockAction2])

    const { result } = renderHook(() => useActions())

    // Wait for initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.currentAction).toEqual(mockAction1)
  })

  it('currentAction returns null when no actions', async () => {
    mockFetchActions.mockResolvedValue([])

    const { result } = renderHook(() => useActions())

    // Wait for initial fetch (will fallback to mock, but test the logic)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // After swiping all actions
    const actions = result.current.actions
    for (const action of actions) {
      await act(async () => {
        await result.current.handleSwipe(action.id, 'left')
      })
    }

    expect(result.current.currentAction).toBeNull()
    expect(result.current.remainingCount).toBe(0)
  })

  it('remainingCount reflects totalCount from count endpoint', async () => {
    mockFetchActions.mockResolvedValue([mockAction1, mockAction2])
    mockFetchActionsCount.mockResolvedValue(100) // Total count is more than loaded

    const { result } = renderHook(() => useActions())

    // Wait for initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // remainingCount should be totalCount (100), not actions.length (2)
    expect(result.current.totalCount).toBe(100)
    expect(result.current.remainingCount).toBe(100)
    expect(result.current.actions.length).toBe(2)
  })

  it('refresh triggers reload of actions', async () => {
    mockFetchActions.mockResolvedValueOnce([mockAction1]).mockResolvedValueOnce([mockAction2])

    const { result } = renderHook(() => useActions())

    // Wait for initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.actions).toEqual([mockAction1])
    expect(mockFetchActions).toHaveBeenCalledTimes(1)

    // Call refresh
    await act(async () => {
      await result.current.refresh()
    })

    expect(mockFetchActions).toHaveBeenCalledTimes(2)
    expect(result.current.actions).toEqual([mockAction2])
  })

  it('sets loading state correctly during fetch', async () => {
    let resolvePromise: (value: ActionResponse[]) => void
    const promise = new Promise<ActionResponse[]>((resolve) => {
      resolvePromise = resolve
    })
    mockFetchActions.mockReturnValue(promise)

    const { result } = renderHook(() => useActions())

    // Initially loading
    expect(result.current.loading).toBe(true)

    // Resolve the promise
    await act(async () => {
      resolvePromise!([mockAction1])
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.loading).toBe(false)
  })

  it('passes actionType filter to fetchActions', async () => {
    mockFetchActions.mockResolvedValue([mockAction1])

    const { result } = renderHook(() => useActions('respond_to_message'))

    // Flush the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockFetchActions).toHaveBeenCalledTimes(1)
    expect(mockFetchActions).toHaveBeenCalledWith('pending', 50, 'respond_to_message')
    expect(result.current.actions).toEqual([mockAction1])
  })

  it('refetches when actionType changes', async () => {
    mockFetchActions.mockResolvedValue([mockAction1])

    const { result, rerender } = renderHook(({ actionType }) => useActions(actionType), {
      initialProps: { actionType: undefined as string | undefined }
    })

    // Flush the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockFetchActions).toHaveBeenCalledTimes(1)
    expect(mockFetchActions).toHaveBeenCalledWith('pending', 50, undefined)

    // Change the actionType
    mockFetchActions.mockResolvedValue([mockAction2])
    rerender({ actionType: 'eod_contact' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockFetchActions).toHaveBeenCalledTimes(2)
    expect(mockFetchActions).toHaveBeenLastCalledWith('pending', 50, 'eod_contact')
    expect(result.current.actions).toEqual([mockAction2])
  })
})
