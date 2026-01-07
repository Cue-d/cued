import { render, screen } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { AttachmentDisplay } from '@/components/Attachments'

// Mock window.open for testing image click behavior
const mockOpen = vi.fn()
vi.stubGlobal('open', mockOpen)

describe('AttachmentDisplay', () => {
  beforeEach(() => {
    mockOpen.mockClear()
  })

  it('returns null when attachments array is empty', () => {
    const { container } = render(<AttachmentDisplay attachments={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders image attachments with thumbnail URL', () => {
    const attachments = [{ id: 1, filename: 'photo.jpg', size: 1024, isImage: true }]
    render(<AttachmentDisplay attachments={attachments} />)

    const img = screen.getByAltText('photo.jpg')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', 'http://localhost:8000/attachments/1/thumbnail')
  })

  it('renders file attachments with filename and size', () => {
    const attachments = [{ id: 2, filename: 'document.pdf', size: 2048, isImage: false }]
    render(<AttachmentDisplay attachments={attachments} />)

    expect(screen.getByText('document.pdf')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
  })

  it('renders fallback filename for attachments without name', () => {
    const attachments = [{ id: 3, filename: null, size: 1024, isImage: false }]
    render(<AttachmentDisplay attachments={attachments} />)

    expect(screen.getByText('File')).toBeInTheDocument()
  })

  it('renders fallback alt text for images without filename', () => {
    const attachments = [{ id: 4, filename: null, size: 1024, isImage: true }]
    render(<AttachmentDisplay attachments={attachments} />)

    expect(screen.getByAltText('Image')).toBeInTheDocument()
  })

  it('renders multiple attachments', () => {
    const attachments = [
      { id: 1, filename: 'photo1.jpg', size: 1024, isImage: true },
      { id: 2, filename: 'photo2.jpg', size: 2048, isImage: true },
      { id: 3, filename: 'doc.pdf', size: 3072, isImage: false }
    ]
    render(<AttachmentDisplay attachments={attachments} />)

    expect(screen.getByAltText('photo1.jpg')).toBeInTheDocument()
    expect(screen.getByAltText('photo2.jpg')).toBeInTheDocument()
    expect(screen.getByText('doc.pdf')).toBeInTheDocument()
  })

  it('applies compact styling when compact prop is true', () => {
    const attachments = [{ id: 1, filename: 'doc.pdf', size: 1024, isImage: false }]
    render(<AttachmentDisplay attachments={attachments} compact />)

    // Compact uses text-xs for filename
    const filename = screen.getByText('doc.pdf')
    expect(filename).toHaveClass('text-xs')
  })

  it('applies normal styling when compact prop is false', () => {
    const attachments = [{ id: 1, filename: 'doc.pdf', size: 1024, isImage: false }]
    render(<AttachmentDisplay attachments={attachments} compact={false} />)

    // Non-compact uses text-sm for filename
    const filename = screen.getByText('doc.pdf')
    expect(filename).toHaveClass('text-sm')
  })

  it('opens full image in new window on click', () => {
    const attachments = [{ id: 5, filename: 'photo.jpg', size: 1024, isImage: true }]
    render(<AttachmentDisplay attachments={attachments} />)

    const img = screen.getByAltText('photo.jpg')
    img.click()

    expect(mockOpen).toHaveBeenCalledWith('http://localhost:8000/attachments/5/file', '_blank')
  })

  it('links file attachments to download URL', () => {
    const attachments = [{ id: 6, filename: 'doc.pdf', size: 1024, isImage: false }]
    render(<AttachmentDisplay attachments={attachments} />)

    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', 'http://localhost:8000/attachments/6/file')
    expect(link).toHaveAttribute('target', '_blank')
  })
})
