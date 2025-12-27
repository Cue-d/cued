import { cn } from '@/lib/utils'

interface AvatarProps {
  initials?: string
  isGroup?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizeClasses = {
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-12 h-12 text-base'
}

const bgColors = [
  'bg-blue-500',
  'bg-green-500',
  'bg-purple-500',
  'bg-orange-500',
  'bg-pink-500',
  'bg-teal-500'
]

const Avatar = ({ initials, isGroup, size = 'md', className }: AvatarProps) => {
  const colorIndex = (initials?.charCodeAt(0) || 0) % bgColors.length

  if (isGroup) {
    return (
      <div className={cn('relative', sizeClasses[size], className)}>
        <div className="absolute top-0 left-0 w-6 h-6 rounded-full bg-gray-400 border-2 border-[#f6f6f6] flex items-center justify-center text-white text-[10px] font-medium">
          {initials?.[0] || '?'}
        </div>
        <div className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-gray-500 border-2 border-[#f6f6f6] flex items-center justify-center text-white text-[10px] font-medium">
          +
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'rounded-full flex items-center justify-center text-white font-medium flex-shrink-0',
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
