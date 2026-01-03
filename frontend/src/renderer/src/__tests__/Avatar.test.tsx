import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import Avatar from '@/components/Avatar'

describe('Avatar', () => {
  it('renders with initials', () => {
    render(<Avatar initials="JD" />)
    expect(screen.getByText('JD')).toBeInTheDocument()
  })

  it('renders fallback "?" when no initials provided', () => {
    render(<Avatar />)
    expect(screen.getByText('?')).toBeInTheDocument()
  })

  it('applies size classes correctly', () => {
    render(<Avatar initials="AB" size="lg" />)
    const avatar = screen.getByText('AB')
    expect(avatar).toHaveClass('w-12', 'h-12')
  })

  it('renders group avatar with multiple members', () => {
    render(<Avatar isGroup groupMembers={['AB', 'CD']} />)
    expect(screen.getByText('AB')).toBeInTheDocument()
    expect(screen.getByText('CD')).toBeInTheDocument()
  })
})
