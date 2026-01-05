import { cn } from '@/lib/utils'

interface AvatarProps {
  initials?: string
  isGroup?: boolean
  groupMembers?: string[] // Array of initials for group members
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}

const sizeClasses = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-12 h-12 text-base'
}

// Muted, sophisticated color palette
const bgColors = [
  'bg-slate-500',
  'bg-zinc-500',
  'bg-stone-500',
  'bg-gray-500',
  'bg-neutral-500',
  'bg-slate-600',
  'bg-zinc-600',
  'bg-stone-600'
]

const getColorForInitials = (initials: string) => {
  const code = initials.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return bgColors[code % bgColors.length]
}

const Avatar = ({ initials, isGroup, groupMembers, size = 'md', className }: AvatarProps) => {
  const colorIndex = (initials?.charCodeAt(0) || 0) % bgColors.length

  if (isGroup && groupMembers && groupMembers.length >= 2) {
    // Show 2 stacked avatars like iMessage
    const member1 = groupMembers[0]
    const member2 = groupMembers[1]
    const color1 = getColorForInitials(member1)
    const color2 = getColorForInitials(member2)

    return (
      <div className={cn('relative shrink-0', sizeClasses[size], className)}>
        {/* Back avatar (top-left) */}
        <div
          className={cn(
            'absolute top-0 left-0 w-6 h-6 rounded-full border-2 border-imessage-sidebar flex items-center justify-center text-white text-[10px] font-medium',
            color1
          )}
        >
          {member1}
        </div>
        {/* Front avatar (bottom-right) */}
        <div
          className={cn(
            'absolute bottom-0 right-0 w-6 h-6 rounded-full border-2 border-imessage-sidebar flex items-center justify-center text-white text-[10px] font-medium',
            color2
          )}
        >
          {member2}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'rounded-full flex items-center justify-center text-white font-medium shrink-0',
        sizeClasses[size],
        bgColors[colorIndex],
        className
      )}
    >
      {initials || '?'}
    </div>
  )
}

export default Avatar
