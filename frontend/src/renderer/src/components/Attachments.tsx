import { FileIcon } from 'lucide-react'
import { API_BASE } from '@/api/client'
import { formatFileSize } from '@/lib/utils'

export interface AttachmentData {
  id: number
  filename: string | null
  size: number | null
  isImage: boolean
}

interface ImageAttachmentProps {
  attachment: AttachmentData
  maxSize?: number
}

function ImageAttachment({ attachment, maxSize = 300 }: ImageAttachmentProps) {
  const thumbnailUrl = `${API_BASE}/attachments/${attachment.id}/thumbnail`
  const fullUrl = `${API_BASE}/attachments/${attachment.id}/file`

  return (
    <img
      src={thumbnailUrl}
      alt={attachment.filename || 'Image'}
      className="rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
      style={{ maxWidth: maxSize, maxHeight: maxSize }}
      onClick={() => window.open(fullUrl, '_blank')}
      onError={(e) => {
        ;(e.target as HTMLImageElement).style.display = 'none'
      }}
    />
  )
}

interface FileAttachmentProps {
  attachment: AttachmentData
  compact?: boolean
}

function FileAttachment({ attachment, compact = false }: FileAttachmentProps) {
  const fileUrl = `${API_BASE}/attachments/${attachment.id}/file`

  return (
    <a
      href={fileUrl}
      className="flex items-center gap-2 p-2 bg-muted/50 rounded-lg hover:bg-muted transition-colors"
      target="_blank"
      rel="noopener noreferrer"
    >
      <FileIcon
        className={compact ? 'w-6 h-6 text-muted-foreground' : 'w-8 h-8 text-muted-foreground'}
      />
      <div className="min-w-0">
        <p className={compact ? 'text-xs font-medium truncate' : 'text-sm font-medium truncate'}>
          {attachment.filename || 'File'}
        </p>
        {attachment.size && (
          <p
            className={
              compact ? 'text-[10px] text-muted-foreground' : 'text-xs text-muted-foreground'
            }
          >
            {formatFileSize(attachment.size)}
          </p>
        )}
      </div>
    </a>
  )
}

interface AttachmentDisplayProps {
  attachments: AttachmentData[]
  maxImageSize?: number
  compact?: boolean
}

export function AttachmentDisplay({
  attachments,
  maxImageSize = 300,
  compact = false
}: AttachmentDisplayProps) {
  if (attachments.length === 0) return null

  return (
    <div className="flex flex-col gap-2 mb-2">
      {attachments.map((att) =>
        att.isImage ? (
          <ImageAttachment key={att.id} attachment={att} maxSize={maxImageSize} />
        ) : (
          <FileAttachment key={att.id} attachment={att} compact={compact} />
        )
      )}
    </div>
  )
}
