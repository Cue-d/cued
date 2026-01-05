import { Clock, FileText, Tag, User } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { ActionResponse } from '@/api/actions'
import Avatar from '@/components/Avatar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

interface ContactFormData {
  name: string
  tags: string
  notes: string
}

interface EODContactCardProps {
  action: ActionResponse
  formData: ContactFormData
  onFormChange: (data: ContactFormData) => void
  className?: string
}

export interface EODContactCardRef {
  focusInput: () => void
}

function getInitials(name: string | null): string {
  if (!name) return '?'
  const parts = name.split(' ').filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return name.substring(0, 2).toUpperCase()
}

function formatMeetingTime(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export const EODContactCard = forwardRef<EODContactCardRef, EODContactCardProps>(
  function EODContactCard({ action, formData, onFormChange, className }, ref) {
    const nameInputRef = useRef<HTMLInputElement>(null)

    useImperativeHandle(ref, () => ({
      focusInput: () => {
        nameInputRef.current?.focus()
      }
    }))

    useEffect(() => {
      // Auto-focus the name input when the card mounts
      const timer = setTimeout(() => {
        nameInputRef.current?.focus()
      }, 300)
      return () => clearTimeout(timer)
    }, [])

    const personName = action.person_name || 'Unknown'
    const initials = getInitials(personName)
    const meetingTime = action.created_at ? formatMeetingTime(action.created_at) : 'earlier'

    // Parse tags from comma-separated string
    const tagList = formData.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    return (
      <Card
        className={cn(
          'w-full h-full flex flex-col overflow-hidden bg-card border-border shadow-2xl',
          className
        )}
      >
        {/* Header */}
        <CardHeader className="shrink-0 border-b border-border pb-4">
          <div className="flex items-center gap-4">
            <Avatar initials={initials} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                <Clock className="w-4 h-4" />
                <span>You met someone new today</span>
              </div>
              <h3 className="font-semibold text-xl text-foreground">{personName}</h3>
              <p className="text-sm text-muted-foreground">at {meetingTime}</p>
            </div>
          </div>
        </CardHeader>

        {/* Form Content */}
        <CardContent className="flex-1 overflow-y-auto py-6 space-y-5">
          <p className="text-muted-foreground text-sm">
            Tell me a bit more about them so you can remember this connection later.
          </p>

          {/* Name Field */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <User className="w-4 h-4 text-muted-foreground" />
              Name
            </label>
            <Input
              ref={nameInputRef}
              value={formData.name}
              onChange={(e) => onFormChange({ ...formData, name: e.target.value })}
              placeholder="Their name..."
              className="bg-background"
            />
          </div>

          {/* Tags Field */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Tag className="w-4 h-4 text-muted-foreground" />
              Tags
            </label>
            <Input
              value={formData.tags}
              onChange={(e) => onFormChange({ ...formData, tags: e.target.value })}
              placeholder="work, friend, investor, met at conference..."
              className="bg-background"
            />
            {tagList.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {tagList.map((tag, i) => (
                  <Badge key={i} variant="secondary" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Notes Field */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <FileText className="w-4 h-4 text-muted-foreground" />
              Notes
            </label>
            <Textarea
              value={formData.notes}
              onChange={(e) => onFormChange({ ...formData, notes: e.target.value })}
              placeholder="Where did you meet? What did you talk about? Any follow-ups?"
              className="min-h-[100px] max-h-[200px] resize-none bg-background"
            />
          </div>
        </CardContent>

        {/* Footer */}
        <div className="shrink-0 border-t border-border p-4 bg-muted/30">
          <p className="text-xs text-muted-foreground text-center">← Skip · ↑ Snooze · Save →</p>
        </div>
      </Card>
    )
  }
)

export type { ContactFormData }
