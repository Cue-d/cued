import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EODContactCard } from '@/components/ActionQueue/EODContactCard'
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
  )
}))

// Mock Input component
vi.mock('@/components/ui/input', () => ({
  // eslint-disable-next-line react/display-name
  Input: React.forwardRef(
    (
      {
        value,
        onChange,
        placeholder,
        ...props
      }: {
        value: string
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
        placeholder?: string
      },
      ref: React.Ref<HTMLInputElement>
    ) => (
      <input
        ref={ref}
        data-testid={placeholder?.includes('name') ? 'name-input' : 'tags-input'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        {...props}
      />
    )
  )
}))

// Mock Textarea component
vi.mock('@/components/ui/textarea', () => ({
  Textarea: ({
    value,
    onChange,
    placeholder
  }: {
    value: string
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
    placeholder?: string
  }) => (
    <textarea
      data-testid="notes-textarea"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  )
}))

// Mock Badge component
vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="badge">{children}</span>
  )
}))

const mockAction: ActionResponse = {
  id: 1,
  type: 'eod_contact',
  status: 'pending',
  priority: 75,
  chat_id: 3,
  person_id: 3,
  message_id: null,
  payload: { met_at: 'Tech Conference 2026' },
  created_at: Math.floor(Date.now() / 1000) - 10800, // 3 hours ago
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

const mockActionWithoutTimestamp: ActionResponse = {
  ...mockAction,
  created_at: 0
}

describe('EODContactCard', () => {
  const mockOnFormChange = vi.fn()
  const defaultFormData = {
    name: 'Jordan Lee',
    tags: '',
    notes: ''
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders person name and meeting time', () => {
    render(
      <EODContactCard
        action={mockAction}
        formData={defaultFormData}
        onFormChange={mockOnFormChange}
      />
    )

    expect(screen.getByText('Jordan Lee')).toBeInTheDocument()
    expect(screen.getByText(/You met someone new today/)).toBeInTheDocument()
    expect(screen.getByText(/^at /)).toBeInTheDocument()
  })

  it('renders "Unknown" when person name is not available', () => {
    const actionWithoutName: ActionResponse = {
      ...mockAction,
      person_name: null
    }

    render(
      <EODContactCard
        action={actionWithoutName}
        formData={{ ...defaultFormData, name: '' }}
        onFormChange={mockOnFormChange}
      />
    )

    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })

  it('renders "earlier" when created_at is missing', () => {
    render(
      <EODContactCard
        action={mockActionWithoutTimestamp}
        formData={defaultFormData}
        onFormChange={mockOnFormChange}
      />
    )

    expect(screen.getByText(/at earlier/)).toBeInTheDocument()
  })

  it('renders correct initials for full name', () => {
    render(
      <EODContactCard
        action={mockAction}
        formData={defaultFormData}
        onFormChange={mockOnFormChange}
      />
    )

    expect(screen.getByTestId('avatar')).toHaveTextContent('JL')
  })

  it('renders correct initials for single name', () => {
    const actionWithSingleName: ActionResponse = {
      ...mockAction,
      person_name: 'Jordan'
    }

    render(
      <EODContactCard
        action={actionWithSingleName}
        formData={{ ...defaultFormData, name: 'Jordan' }}
        onFormChange={mockOnFormChange}
      />
    )

    expect(screen.getByTestId('avatar')).toHaveTextContent('JO')
  })

  it('input fields update form data on change', () => {
    render(
      <EODContactCard
        action={mockAction}
        formData={defaultFormData}
        onFormChange={mockOnFormChange}
      />
    )

    const nameInput = screen.getByTestId('name-input')
    fireEvent.change(nameInput, { target: { value: 'Updated Name' } })

    expect(mockOnFormChange).toHaveBeenCalledWith({
      ...defaultFormData,
      name: 'Updated Name'
    })
  })

  it('tags input updates form data', () => {
    render(
      <EODContactCard
        action={mockAction}
        formData={defaultFormData}
        onFormChange={mockOnFormChange}
      />
    )

    const tagsInput = screen.getByTestId('tags-input')
    fireEvent.change(tagsInput, { target: { value: 'work, friend' } })

    expect(mockOnFormChange).toHaveBeenCalledWith({
      ...defaultFormData,
      tags: 'work, friend'
    })
  })

  it('notes textarea updates form data', () => {
    render(
      <EODContactCard
        action={mockAction}
        formData={defaultFormData}
        onFormChange={mockOnFormChange}
      />
    )

    const notesTextarea = screen.getByTestId('notes-textarea')
    fireEvent.change(notesTextarea, { target: { value: 'Met at conference' } })

    expect(mockOnFormChange).toHaveBeenCalledWith({
      ...defaultFormData,
      notes: 'Met at conference'
    })
  })

  it('tags are parsed and displayed as badges', () => {
    const formDataWithTags = {
      ...defaultFormData,
      tags: 'work, friend, investor'
    }

    render(
      <EODContactCard
        action={mockAction}
        formData={formDataWithTags}
        onFormChange={mockOnFormChange}
      />
    )

    const badges = screen.getAllByTestId('badge')
    expect(badges).toHaveLength(3)
    expect(screen.getByText('work')).toBeInTheDocument()
    expect(screen.getByText('friend')).toBeInTheDocument()
    expect(screen.getByText('investor')).toBeInTheDocument()
  })

  it('tags with extra spaces are trimmed', () => {
    const formDataWithSpaces = {
      ...defaultFormData,
      tags: 'work , friend , investor'
    }

    render(
      <EODContactCard
        action={mockAction}
        formData={formDataWithSpaces}
        onFormChange={mockOnFormChange}
      />
    )

    const badges = screen.getAllByTestId('badge')
    expect(badges).toHaveLength(3)
    expect(screen.getByText('work')).toBeInTheDocument()
    expect(screen.getByText('friend')).toBeInTheDocument()
    expect(screen.getByText('investor')).toBeInTheDocument()
  })

  it('empty tags do not render badges', () => {
    render(
      <EODContactCard
        action={mockAction}
        formData={defaultFormData}
        onFormChange={mockOnFormChange}
      />
    )

    const badges = screen.queryAllByTestId('badge')
    expect(badges).toHaveLength(0)
  })

  it('focusInput ref method works correctly', () => {
    const ref = { current: null } as { current: { focusInput: () => void } | null }

    render(
      <EODContactCard
        action={mockAction}
        formData={defaultFormData}
        onFormChange={mockOnFormChange}
        ref={ref}
      />
    )

    expect(ref.current).not.toBeNull()
    expect(typeof ref.current?.focusInput).toBe('function')

    const nameInput = screen.getByTestId('name-input') as HTMLInputElement
    const focusSpy = vi.spyOn(nameInput, 'focus')

    ref.current?.focusInput()

    expect(focusSpy).toHaveBeenCalled()
  })

  it('auto-focuses name input on mount', async () => {
    render(
      <EODContactCard
        action={mockAction}
        formData={defaultFormData}
        onFormChange={mockOnFormChange}
      />
    )

    const nameInput = screen.getByTestId('name-input') as HTMLInputElement
    const focusSpy = vi.spyOn(nameInput, 'focus')

    // Advance timers to trigger the useEffect timeout
    await vi.advanceTimersByTimeAsync(300)

    expect(focusSpy).toHaveBeenCalled()
  })

  it('displays form data values correctly', () => {
    const formData = {
      name: 'John Doe',
      tags: 'work, friend',
      notes: 'Met at conference'
    }

    render(
      <EODContactCard action={mockAction} formData={formData} onFormChange={mockOnFormChange} />
    )

    expect(screen.getByTestId('name-input')).toHaveValue('John Doe')
    expect(screen.getByTestId('tags-input')).toHaveValue('work, friend')
    expect(screen.getByTestId('notes-textarea')).toHaveValue('Met at conference')
  })

  it('renders placeholder text correctly', () => {
    render(
      <EODContactCard
        action={mockAction}
        formData={defaultFormData}
        onFormChange={mockOnFormChange}
      />
    )

    expect(screen.getByPlaceholderText('Their name...')).toBeInTheDocument()
    expect(
      screen.getByPlaceholderText('work, friend, investor, met at conference...')
    ).toBeInTheDocument()
    expect(
      screen.getByPlaceholderText('Where did you meet? What did you talk about? Any follow-ups?')
    ).toBeInTheDocument()
  })

  it('renders instructional text', () => {
    render(
      <EODContactCard
        action={mockAction}
        formData={defaultFormData}
        onFormChange={mockOnFormChange}
      />
    )

    expect(
      screen.getByText('Tell me a bit more about them so you can remember this connection later.')
    ).toBeInTheDocument()
  })

  it('handles empty form data gracefully', () => {
    const emptyFormData = {
      name: '',
      tags: '',
      notes: ''
    }

    render(
      <EODContactCard
        action={mockAction}
        formData={emptyFormData}
        onFormChange={mockOnFormChange}
      />
    )

    expect(screen.getByTestId('name-input')).toHaveValue('')
    expect(screen.getByTestId('tags-input')).toHaveValue('')
    expect(screen.getByTestId('notes-textarea')).toHaveValue('')
  })
})
