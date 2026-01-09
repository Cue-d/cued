import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CardStack } from '@/components/ActionQueue/CardStack'
import type { ActionResponse } from '@/api/actions'
import * as actionsApi from '@/api/actions'

// Mock motion components
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: { children: React.ReactNode }) => <div {...props}>{children}</div>
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAnimation: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    set: vi.fn()
  })
}))

// Mock party-popper icon to avoid useAnimation issues
vi.mock('@/components/ui/party-popper', () => {
  const MockPartyPopperIcon = React.forwardRef<HTMLSpanElement>(() => (
    <span data-testid="party-popper-icon">🎉</span>
  ))
  MockPartyPopperIcon.displayName = 'MockPartyPopperIcon'
  return { PartyPopperIcon: MockPartyPopperIcon }
})

// Mock child components
vi.mock('@/components/ActionQueue/SwipeableCard', () => ({
  SwipeableCard: ({
    children,
    onSwipe,
    disabled,
    triggerSwipe
  }: {
    children: React.ReactNode
    onSwipe: (direction: 'left' | 'right' | 'up') => void
    disabled?: boolean
    triggerSwipe?: 'left' | 'right' | 'up' | null
  }) => {
    // Simulate the useEffect behavior - call onSwipe when triggerSwipe changes
    React.useEffect(() => {
      if (triggerSwipe) {
        onSwipe(triggerSwipe)
      }
    }, [triggerSwipe, onSwipe])

    return (
      <div data-testid="swipeable-card" data-disabled={disabled} data-trigger-swipe={triggerSwipe}>
        {children}
        <button onClick={() => onSwipe('left')}>Swipe Left</button>
        <button onClick={() => onSwipe('right')}>Swipe Right</button>
        <button onClick={() => onSwipe('up')}>Swipe Up</button>
      </div>
    )
  }
}))

vi.mock('@/components/ActionQueue/MessageResponseCard', () => ({
  MessageResponseCard: ({
    action,
    responseText,
    onResponseChange
  }: {
    action: ActionResponse
    responseText: string
    onResponseChange: (text: string) => void
  }) => (
    <div data-testid="message-response-card">
      <div>Message: {action.message_text}</div>
      <textarea
        data-testid="response-textarea"
        value={responseText}
        onChange={(e) => onResponseChange(e.target.value)}
      />
    </div>
  )
}))

vi.mock('@/components/ActionQueue/EODContactCard', () => ({
  EODContactCard: ({
    action,
    formData,
    onFormChange
  }: {
    action: ActionResponse
    formData: { name: string; tags: string; notes: string }
    onFormChange: (data: { name: string; tags: string; notes: string }) => void
  }) => (
    <div data-testid="eod-contact-card">
      <div>Person: {action.person_name}</div>
      <input
        data-testid="contact-name"
        value={formData.name}
        onChange={(e) => onFormChange({ ...formData, name: e.target.value })}
      />
      <input
        data-testid="contact-tags"
        value={formData.tags}
        onChange={(e) => onFormChange({ ...formData, tags: e.target.value })}
      />
      <textarea
        data-testid="contact-notes"
        value={formData.notes}
        onChange={(e) => onFormChange({ ...formData, notes: e.target.value })}
      />
    </div>
  )
}))

vi.mock('@/api/actions', () => ({
  addContactContext: vi.fn()
}))

const mockAddContactContext = vi.mocked(actionsApi.addContactContext)

const mockMessageAction: ActionResponse = {
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

const mockEODAction: ActionResponse = {
  id: 2,
  type: 'eod_contact',
  status: 'pending',
  priority: 75,
  chat_id: 3,
  person_id: 3,
  message_id: null,
  payload: { met_at: 'Tech Conference 2026' },
  created_at: Date.now() - 10800000,
  remind_at: null,
  snoozed_until: null,
  completed_at: null,
  discarded_at: null,
  chat_name: null,
  person_name: 'Jordan Lee',
  message_text: null,
  message_timestamp: null,
  recent_messages: []
}

describe('CardStack', () => {
  const mockOnSwipe = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    mockAddContactContext.mockResolvedValue({ success: true })
  })

  it('renders "All caught up" when no actions', () => {
    render(<CardStack actions={[]} onSwipe={mockOnSwipe} />)

    expect(screen.getByText('All caught up!')).toBeInTheDocument()
    expect(screen.getByText(/You can exhale now/)).toBeInTheDocument()
  })

  it('renders visible cards (up to 3)', () => {
    const actions = [mockMessageAction, mockEODAction]
    render(<CardStack actions={actions} onSwipe={mockOnSwipe} />)

    expect(screen.getAllByTestId('swipeable-card')).toHaveLength(1) // Only top card is swipeable
    expect(screen.getByTestId('message-response-card')).toBeInTheDocument()
  })

  it('displays correct remaining count', () => {
    const actions = [mockMessageAction, mockEODAction]
    render(<CardStack actions={actions} onSwipe={mockOnSwipe} />)

    expect(screen.getByText('2 Left')).toBeInTheDocument()
  })

  it('calls onSwipe with response text for right swipe on message action', async () => {
    render(<CardStack actions={[mockMessageAction]} onSwipe={mockOnSwipe} />)

    const textarea = screen.getByTestId('response-textarea')
    fireEvent.change(textarea, { target: { value: 'My response' } })

    const swipeRightButton = screen.getByText('Swipe Right')
    fireEvent.click(swipeRightButton)

    await waitFor(() => {
      expect(mockOnSwipe).toHaveBeenCalledWith(1, 'right', 'My response')
    })
  })

  it('calls onSwipe with snooze minutes for up swipe', async () => {
    render(<CardStack actions={[mockMessageAction]} onSwipe={mockOnSwipe} />)

    const swipeUpButton = screen.getByText('Swipe Up')
    fireEvent.click(swipeUpButton)

    await waitFor(() => {
      expect(mockOnSwipe).toHaveBeenCalledWith(1, 'up', undefined, 60)
    })
  })

  it('calls onSwipe without response text for left swipe', async () => {
    render(<CardStack actions={[mockMessageAction]} onSwipe={mockOnSwipe} />)

    const swipeLeftButton = screen.getByText('Swipe Left')
    fireEvent.click(swipeLeftButton)

    await waitFor(() => {
      expect(mockOnSwipe).toHaveBeenCalledWith(1, 'left', undefined, undefined)
    })
  })

  it('renders EODContactCard for eod_contact action type', () => {
    render(<CardStack actions={[mockEODAction]} onSwipe={mockOnSwipe} />)

    expect(screen.getByTestId('eod-contact-card')).toBeInTheDocument()
    expect(screen.getByText('Person: Jordan Lee')).toBeInTheDocument()
  })

  it('renders MessageResponseCard for respond_to_message action type', () => {
    render(<CardStack actions={[mockMessageAction]} onSwipe={mockOnSwipe} />)

    expect(screen.getByTestId('message-response-card')).toBeInTheDocument()
    expect(screen.getByText('Message: Test message')).toBeInTheDocument()
  })

  it('calls addContactContext on right swipe for EOD contact with notes', async () => {
    render(<CardStack actions={[mockEODAction]} onSwipe={mockOnSwipe} />)

    const notesTextarea = screen.getByTestId('contact-notes')
    fireEvent.change(notesTextarea, { target: { value: 'Met at conference' } })

    const swipeRightButton = screen.getByText('Swipe Right')
    fireEvent.click(swipeRightButton)

    await waitFor(() => {
      expect(mockAddContactContext).toHaveBeenCalledWith(3, 'Met at conference')
      expect(mockOnSwipe).toHaveBeenCalledWith(2, 'right', undefined, undefined)
    })
  })

  it('keyboard shortcuts (ArrowLeft/ArrowRight) trigger swipe', async () => {
    const { container } = render(<CardStack actions={[mockMessageAction]} onSwipe={mockOnSwipe} />)

    // The container div with tabIndex={0} handles keyboard events
    const focusableContainer = container.querySelector('[tabindex="0"]')!
    fireEvent.keyDown(focusableContainer, { key: 'ArrowLeft' })

    await waitFor(() => {
      expect(mockOnSwipe).toHaveBeenCalledWith(1, 'left', undefined, undefined)
    })

    mockOnSwipe.mockClear()

    fireEvent.keyDown(focusableContainer, { key: 'ArrowRight' })

    await waitFor(() => {
      expect(mockOnSwipe).toHaveBeenCalled()
    })
  })

  it('does not trigger keyboard shortcuts when typing in input', () => {
    render(<CardStack actions={[mockMessageAction]} onSwipe={mockOnSwipe} />)

    const textarea = screen.getByTestId('response-textarea')
    // Focus the textarea and fire a keyDown event on it
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'ArrowLeft' })

    // Should not trigger swipe when key event originates from textarea
    // (the container's onKeyDown handler only triggers when the container itself receives the event)
    expect(mockOnSwipe).not.toHaveBeenCalled()
  })

  it('disables buttons when processing', async () => {
    const slowOnSwipe = vi.fn().mockImplementation(() => new Promise(() => {})) // Never resolves

    render(<CardStack actions={[mockMessageAction]} onSwipe={slowOnSwipe} />)

    const swipeRightButton = screen.getByText('Swipe Right')
    fireEvent.click(swipeRightButton)

    // Wait for processing state
    await waitFor(() => {
      const card = screen.getByTestId('swipeable-card')
      expect(card).toHaveAttribute('data-disabled', 'true')
    })

    const discardButton = screen.getByRole('button', { name: 'Discard' })
    const sendButton = screen.getByRole('button', { name: 'Send' })

    expect(discardButton).toBeDisabled()
    expect(sendButton).toBeDisabled()
  })

  it('handles button clicks to trigger swipe', async () => {
    render(<CardStack actions={[mockMessageAction]} onSwipe={mockOnSwipe} />)

    const sendButton = screen.getByRole('button', { name: 'Send' })
    fireEvent.click(sendButton)

    await waitFor(() => {
      expect(mockOnSwipe).toHaveBeenCalled()
    })
  })

  it('does not trigger swipe when no actions', () => {
    render(<CardStack actions={[]} onSwipe={mockOnSwipe} />)

    fireEvent.keyDown(window, { key: 'ArrowLeft' })

    expect(mockOnSwipe).not.toHaveBeenCalled()
  })
})
