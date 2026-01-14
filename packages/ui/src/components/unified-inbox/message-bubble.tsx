import type React from "react"
import { cn } from "../../lib/utils"
import type { Message, MessageAttachment } from "./message-types"

interface MessageBubbleProps {
  message: Message
  showTimestamp?: boolean
  showSenderName?: boolean
}

function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/")
}

function isVideoMimeType(mimeType: string): boolean {
  return mimeType.startsWith("video/")
}

function AttachmentPreview({ attachment }: { attachment: MessageAttachment }) {
  if (isImageMimeType(attachment.mimeType)) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        <img
          src={attachment.thumbnailUrl ?? attachment.url}
          alt={attachment.filename}
          className="max-w-full max-h-64 rounded-lg object-contain"
          loading="lazy"
        />
      </a>
    )
  }

  if (isVideoMimeType(attachment.mimeType)) {
    return (
      <video
        src={attachment.url}
        poster={attachment.thumbnailUrl ?? undefined}
        controls
        className="max-w-full max-h-64 rounded-lg"
        preload="metadata"
      >
        <track kind="captions" />
      </video>
    )
  }

  // Generic file attachment
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 px-3 py-2 bg-background/50 rounded-lg border border-border/50 hover:bg-background/80 transition-colors"
    >
      <svg
        className="w-5 h-5 text-muted-foreground flex-shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
        />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{attachment.filename}</div>
        <div className="text-xs text-muted-foreground">
          {formatFileSize(attachment.size)}
        </div>
      </div>
    </a>
  )
}

export function MessageBubble({
  message,
  showTimestamp = false,
  showSenderName = false,
}: MessageBubbleProps): React.ReactElement {
  const senderName = message.sender?.displayName
  const hasAttachments = message.attachments && message.attachments.length > 0
  const hasContent = message.content.trim().length > 0

  return (
    <div
      className={cn(
        "flex flex-col mb-1.5 group",
        message.isFromMe ? "items-end" : "items-start"
      )}
    >
      {/* Sender name for received messages */}
      {showSenderName && !message.isFromMe && senderName && (
        <span className="text-xs font-medium text-muted-foreground mb-1.5 ml-1">
          {senderName}
        </span>
      )}

      {/* Attachments */}
      {hasAttachments && (
        <div className="max-w-[75%] mb-1.5 space-y-1.5">
          {message.attachments!.map((attachment, index) => (
            <AttachmentPreview key={`${message._id}-att-${index}`} attachment={attachment} />
          ))}
        </div>
      )}

      {/* Message bubble - only show if there's content */}
      {hasContent && (
        <div
          className={cn(
            "max-w-[75%] px-4 py-2.5 rounded-2xl break-words transition-all duration-200",
            message.isFromMe
              ? "bg-gradient-to-br from-primary to-primary/90 text-primary-foreground rounded-br-lg shadow-md shadow-primary/15"
              : "bg-muted/70 text-foreground rounded-bl-lg border border-border/20"
          )}
        >
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
            {message.content}
          </p>
        </div>
      )}

      {/* Timestamp */}
      {showTimestamp && (
        <span className="text-[11px] font-medium text-muted-foreground mt-1.5 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          {formatMessageTime(message.sentAt)}
        </span>
      )}
    </div>
  )
}
