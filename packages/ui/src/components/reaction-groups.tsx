import type { ReactionGroup } from "@cued/shared"
import { getInitials } from "@cued/shared"
import { cn } from "../lib/utils"

interface ReactionGroupsProps {
  reactions: ReactionGroup[]
  className?: string
}

function ReactorAvatar({
  displayName,
  isFromMe,
  className,
}: {
  displayName: string
  isFromMe: boolean
  className?: string
}) {
  const initials = getInitials(displayName)
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full text-[8px] font-medium leading-none",
        isFromMe
          ? "bg-primary/20 text-primary"
          : "bg-muted-foreground/20 text-muted-foreground",
        className
      )}
      title={displayName}
    >
      {initials.slice(0, 1)}
    </div>
  )
}

function ReactionGroupBadge({ group }: { group: ReactionGroup }) {
  const visibleReactors = group.reactors.slice(0, 3)
  const overflow = group.reactors.length - visibleReactors.length

  return (
    <div className="group/reaction relative">
      <div className="flex items-center gap-1 rounded-full bg-muted/80 border border-border/50 px-1.5 py-0.5 cursor-default hover:bg-muted transition-colors">
        <span className="text-xs leading-none">{group.emoji}</span>
        <div className="flex -space-x-1">
          {visibleReactors.map((reactor) => (
            <ReactorAvatar
              key={reactor.displayName}
              displayName={reactor.displayName}
              isFromMe={reactor.isFromMe}
              className="w-3.5 h-3.5 ring-1 ring-background"
            />
          ))}
        </div>
        {overflow > 0 && (
          <span className="text-[10px] text-muted-foreground leading-none">
            +{overflow}
          </span>
        )}
      </div>

      {/* Hover card - zero delay, appears instantly */}
      <div className="absolute bottom-full left-0 mb-1 hidden group-hover/reaction:block z-50">
        <div className="rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 p-2 min-w-[120px] max-w-[200px] animate-in fade-in-0 zoom-in-95 duration-100">
          <div className="flex flex-col gap-1">
            {group.reactors.map((reactor) => (
              <div
                key={reactor.displayName}
                className="flex items-center gap-2 text-xs"
              >
                <ReactorAvatar
                  displayName={reactor.displayName}
                  isFromMe={reactor.isFromMe}
                  className="w-4 h-4 shrink-0"
                />
                <span className="truncate">
                  {reactor.displayName}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ReactionGroups({ reactions, className }: ReactionGroupsProps) {
  if (!reactions || reactions.length === 0) return null

  return (
    <div className={cn("flex flex-wrap gap-1 mt-1", className)}>
      {reactions.map((group) => (
        <ReactionGroupBadge key={group.emoji} group={group} />
      ))}
    </div>
  )
}
