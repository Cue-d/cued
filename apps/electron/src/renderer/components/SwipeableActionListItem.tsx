import * as React from "react";
import { Clock, Trash2 } from 'lucide-react'
import {
  type EnrichedAction,
  formatRelativeTime,
  getInitials,
  PLATFORM_CONFIG,
  type ActionPlatform,
} from "@cued/shared";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
  PlatformIcon,
  formatSource,
  type MergeSource,
} from "@cued/ui";
import { SNOOZE_OPTIONS } from "../lib/snooze-options";
import { SwipeableListItem } from "./SwipeableListItem";

interface SwipeableActionListItemProps {
  action: EnrichedAction;
  selected: boolean;
  multiSelected?: boolean;
  showCheckbox?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDiscard: () => void;
  onSnooze: (snoozedUntil: number) => void;
  typeConfig: { icon: React.ReactNode; label: string };
  onContactClick?: (contactId: string) => void;
  openSwipeId?: string | null;
  onSwipeActiveChange?: (actionId: string | null) => void;
}

export function SwipeableActionListItem({
  action,
  selected,
  multiSelected = false,
  showCheckbox = false,
  onClick,
  onDiscard,
  onSnooze,
  typeConfig,
  onContactClick,
  openSwipeId = null,
  onSwipeActiveChange,
}: SwipeableActionListItemProps) {
  // For resolve_contact actions, show formatted merge source instead of raw reason
  let listSummary: string;
  let showReason = true;
  if (action.type === "resolve_contact" && action.mergeSource) {
    const confidence = Math.round((action.mergeConfidence ?? 0) * 100);
    listSummary = `${formatSource(action.mergeSource as MergeSource)} · ${confidence}%`;
    showReason = false; // Merge info is already in the summary
  } else {
    listSummary = action.summary?.trim() || typeConfig.label;
  }

  const platform = action.platform as ActionPlatform | null;
  const platformConfig = platform ? PLATFORM_CONFIG[platform] : null;

  const handleDiscard = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDiscard();
  };

  const handleSnoozeSelect = (snoozedUntil: number) => {
    onSnooze(snoozedUntil);
  };

  return (
    <SwipeableListItem
      itemId={action._id}
      selected={selected}
      multiSelected={multiSelected}
      showCheckbox={showCheckbox}
      onClick={onClick}
      openSwipeId={openSwipeId}
      onSwipeActiveChange={onSwipeActiveChange}
      leftAction={{
        label: "Remind Me",
        control: (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Snooze action"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "inline-flex size-9 cursor-pointer items-center justify-center rounded-full",
                "border border-input bg-background text-foreground shadow-xs transition-[color,box-shadow]",
                "hover:bg-accent hover:text-accent-foreground",
                "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                "outline-none"
              )}
            >
              <Clock size={16} strokeWidth={1.5} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="right"
              align="center"
              sideOffset={8}
              className="w-40 min-w-40"
            >
              {SNOOZE_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSnoozeSelect(option.getTime());
                  }}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      }}
      rightAction={{
        label: "Dismiss",
        labelClassName: "text-destructive",
        control: (
          <Button
            variant="destructive"
            size="icon"
            onClick={handleDiscard}
            aria-label="Discard action"
            className="cursor-pointer rounded-full"
          >
            <Trash2 size={16} strokeWidth={1.5} />
          </Button>
        ),
      }}
    >
      <div className="flex items-center gap-3">
        <Avatar size="lg">
          <AvatarFallback>
            {getInitials(action.contactName ?? "")}
          </AvatarFallback>
          {platformConfig && platform && (
            <AvatarBadge
              className="size-4.5! [&>svg]:size-3.5! ring-0!"
              style={{ backgroundColor: platformConfig.color, color: "white" }}
            >
              <PlatformIcon platform={platform} />
            </AvatarBadge>
          )}
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {action.contactId && onContactClick ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onContactClick(action.contactId!);
                  }}
                  className="block max-w-full font-medium text-sm truncate hover:underline cursor-pointer text-left"
                >
                  {action.contactName}
                </button>
              ) : (
                <span className="block max-w-full font-medium text-sm truncate">
                  {action.contactName}
                </span>
              )}
            </div>
            <span className="shrink-0 text-[10px] tracking-tight text-muted-foreground tabular-nums">
              {formatRelativeTime(action.createdAt)}
            </span>
          </div>
          <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
            <span>{listSummary}</span>
          </div>
          {showReason && action.reason && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
              {action.reason}
            </p>
          )}
        </div>
      </div>
    </SwipeableListItem>
  );
}
