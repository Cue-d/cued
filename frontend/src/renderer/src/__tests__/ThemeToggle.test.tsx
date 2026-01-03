import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import ThemeToggle from '@/components/ThemeToggle'

describe('ThemeToggle', () => {
  it('renders Sun icon when dark mode is active', () => {
    render(<ThemeToggle isDark={true} onToggle={() => {}} />)
    expect(screen.getByTestId('sun-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('moon-icon')).not.toBeInTheDocument()
  })

  it('renders Moon icon when light mode is active', () => {
    render(<ThemeToggle isDark={false} onToggle={() => {}} />)
    expect(screen.getByTestId('moon-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('sun-icon')).not.toBeInTheDocument()
  })

  it('calls onToggle when clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<ThemeToggle isDark={false} onToggle={onToggle} />)

    await user.click(screen.getByRole('button', { name: /toggle theme/i }))

    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
