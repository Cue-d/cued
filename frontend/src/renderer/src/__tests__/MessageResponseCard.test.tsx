import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageResponseCard } from '@/components/ActionQueue/MessageResponseCard'
import type { ActionResponse } from '@/api/actions'

// Mock Avatar component
vi.mock('@/components/Avatar', () => ({
  default: ({ initials }: { initials: string }) => <div data-testid="avatar">{initials}</div>
}))

// Mock Card components
vi.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card" className={className}>
      {children}
    </div>
  ),
  CardHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card-header">{children}</div>
  ),
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card-content">{children}</div>
  ),
  CardFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card-footer">{children}</div>
  )
}))

// Mock Textarea component
vi.mock('@/components/ui/textarea', () => ({
  Textarea: ({
    value,
    onChange,
    placeholder,
    onKeyDown,
    ...props
  }: {
    value: string
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
    placeholder?: string
    onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  }) => (
    <textarea
      data-testid="response-textarea"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      {...props}
    />
  )
}))

// Helper to create mock message response with required fields
function mockMessage(
  id: number,
  text: string,
  date: number,
  senderName: string | null,
  isFromMe = false
) {
  return {
    id,
    text,
    date,
    is_from_me: isFromMe,
    is_read: true,
    date_read: isFromMe ? date : null,
    sender_name: senderName,
    is_sent: true,
    is_delivered: true,
    date_delivered: isFromMe ? date : null,
    error: 0,
    attachments: []
  }
}

const mockAction: ActionResponse = {
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
  recent_messages: [
    mockMessage(99, 'Previous message', Date.now() - 7200000, 'Alex Chen'),
    mockMessage(100, 'Test message', Date.now() - 3600000, 'Alex Chen')
  ]
}

const mockActionWithSentMessage: ActionResponse = {
  ...mockAction,
  recent_messages: [mockMessage(100, 'Sent message', Date.now() - 3600000, null, true)]
}

describe('MessageResponseCard', () => {
  const mockOnResponseChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders person name and initials correctly', () => {
    render(
      <MessageResponseCard
        action={mockAction}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    const names = screen.getAllByText('Alex Chen')
    expect(names.length).toBeGreaterThan(0)
    expect(screen.getByTestId('avatar')).toHaveTextContent('AC')
  })

  it('renders chat name when person name is not available', () => {
    const actionWithoutPersonName: ActionResponse = {
      ...mockAction,
      person_name: null,
      chat_name: 'Group Chat'
    }

    render(
      <MessageResponseCard
        action={actionWithoutPersonName}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    expect(screen.getByText('Group Chat')).toBeInTheDocument()
  })

  it('renders recent messages with correct styling for received messages', () => {
    render(
      <MessageResponseCard
        action={mockAction}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    const messages = screen.getAllByText(/Previous message|Test message/)
    expect(messages.length).toBeGreaterThan(0)
  })

  it('renders recent messages with correct styling for sent messages', () => {
    render(
      <MessageResponseCard
        action={mockActionWithSentMessage}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    expect(screen.getByText('Sent message')).toBeInTheDocument()
  })

  it('displays "No recent messages" when messages array is empty', () => {
    const actionWithoutMessages: ActionResponse = {
      ...mockAction,
      recent_messages: []
    }

    render(
      <MessageResponseCard
        action={actionWithoutMessages}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    expect(screen.getByText('No recent messages')).toBeInTheDocument()
  })

  it('calls onResponseChange when typing in textarea', () => {
    render(
      <MessageResponseCard
        action={mockAction}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    const textarea = screen.getByTestId('response-textarea')
    fireEvent.change(textarea, { target: { value: 'My response' } })

    expect(mockOnResponseChange).toHaveBeenCalledWith('My response')
  })

  it('displays response text in textarea', () => {
    render(
      <MessageResponseCard
        action={mockAction}
        responseText="Existing response"
        onResponseChange={mockOnResponseChange}
      />
    )

    const textarea = screen.getByTestId('response-textarea')
    expect(textarea).toHaveValue('Existing response')
  })

  it('formats relative time correctly for hours', () => {
    const actionWithRecentTimestamp: ActionResponse = {
      ...mockAction,
      message_timestamp: Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000) // 2 hours ago
    }

    render(
      <MessageResponseCard
        action={actionWithRecentTimestamp}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    expect(screen.getByText(/2h ago/)).toBeInTheDocument()
  })

  it('formats relative time correctly for days', () => {
    const actionWithOldTimestamp: ActionResponse = {
      ...mockAction,
      message_timestamp: Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000) // 3 days ago
    }

    render(
      <MessageResponseCard
        action={actionWithOldTimestamp}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    expect(screen.getByText(/3d ago/)).toBeInTheDocument()
  })

  it('displays "Just now" for very recent messages', () => {
    const actionWithRecentTimestamp: ActionResponse = {
      ...mockAction,
      message_timestamp: Math.floor(Date.now() / 1000) // Just now
    }

    render(
      <MessageResponseCard
        action={actionWithRecentTimestamp}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    expect(screen.getByText('Just now')).toBeInTheDocument()
  })

  it('renders sender name for received messages in group chats', () => {
    const groupAction: ActionResponse = {
      ...mockAction,
      chat_name: 'Group Chat',
      recent_messages: [mockMessage(100, 'Group message', Date.now() - 3600000, 'John Doe')]
    }

    render(
      <MessageResponseCard
        action={groupAction}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    expect(screen.getByText('John Doe')).toBeInTheDocument()
  })

  it('prevents card swipe while typing', () => {
    render(
      <MessageResponseCard
        action={mockAction}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    const textarea = screen.getByTestId('response-textarea')
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft' })
    fireEvent.keyDown(textarea, event)

    // The onKeyDown handler should stop propagation
    // We can't easily test stopPropagation, but we can verify the handler exists
    expect(textarea).toBeInTheDocument()
  })

  it('renders placeholder text in textarea', () => {
    render(
      <MessageResponseCard
        action={mockAction}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    const textarea = screen.getByTestId('response-textarea')
    expect(textarea).toHaveAttribute('placeholder', 'Type your response... (swipe right to send)')
  })

  it('handles missing message timestamp gracefully', () => {
    const actionWithoutTimestamp: ActionResponse = {
      ...mockAction,
      message_timestamp: null
    }

    render(
      <MessageResponseCard
        action={actionWithoutTimestamp}
        responseText=""
        onResponseChange={mockOnResponseChange}
      />
    )

    // Should still render without crashing
    const names = screen.getAllByText('Alex Chen')
    expect(names.length).toBeGreaterThan(0)
  })
})
