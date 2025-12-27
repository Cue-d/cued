import { cn } from '@/lib/utils'
import { Message, formatMessageTime } from '@/data/mockData'

interface MessageBubbleProps {
  message: Message
  showTimestamp?: boolean
}

const MessageBubble = ({ message, showTimestamp }: MessageBubbleProps) => {
  return (
    <div className={cn('flex flex-col', message.isSent ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[70%] px-3 py-2 rounded-2xl break-words',
          message.isSent
            ? 'bg-imessage-bubble-sent text-imessage-bubble-sent-foreground rounded-br-md'
            : 'bg-imessage-bubble-received text-imessage-bubble-received-foreground rounded-bl-md'
        )}
      >
        {message.isLink ? (
          <a
            href={message.text}
            className="text-imessage-link underline text-[15px] leading-relaxed"
            target="_blank"
            rel="noopener noreferrer"
          >
            {message.text}
          </a>
        ) : (
          <p className="text-[15px] leading-relaxed">{message.text}</p>
        )}
      </div>
      {showTimestamp && (
        <span className="text-xs text-imessage-timestamp mt-1 px-1">
          {formatMessageTime(message.timestamp)}
        </span>
      )}
    </div>
  )
}

export default MessageBubble
