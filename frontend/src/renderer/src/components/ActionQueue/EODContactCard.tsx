import { Clock, FileText, Tag, User } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { ActionResponse } from '@/api/actions'
import Avatar from '@/components/Avatar'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn, getInitials } from '@/lib/utils'

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
        className={cn('w-full h-full flex flex-col overflow-hidden gap-0 border p-0', className)}
      >
        {/* Header */}
        <CardHeader className="shrink-0 p-3">
          <div className="flex items-center gap-x-3">
            <Avatar initials={initials} size="sm" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Clock className="w-3 h-3" />
                <span>You met someone new today</span>
              </div>
              <h3 className="font-semibold text-sm text-foreground truncate">{personName}</h3>
              <p className="text-xs text-muted-foreground">at {meetingTime}</p>
            </div>
          </div>
        </CardHeader>

        {/* Form Content */}
        <CardContent className="border-t flex-1 p-0 min-h-0">
          <div
            className="h-full overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border/50 [scrollbar-width:thin]"
            style={{ scrollbarColor: 'rgba(128, 128, 128, 0.5) transparent' }}
          >
            <div className="py-6 px-4 space-y-5">
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
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }
)

export type { ContactFormData }
