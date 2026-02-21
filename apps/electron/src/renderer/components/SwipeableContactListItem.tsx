import * as React from "react";
import { Archive } from "lucide-react";
import { getInitials, type ActionPlatform, PLATFORM_CONFIG } from "@cued/shared";
import {
  Avatar,
  AvatarImage,
  AvatarFallback,
  Badge,
  Button,
  PlatformIcon,
  cn,
} from "@cued/ui";
import type { Id } from "@cued/convex";
import { SwipeableListItem } from "./SwipeableListItem";
import {
  HandleIcon,
  deduplicateHandles,
  prioritizeHandles,
  VISIBLE_HANDLE_TYPES,
} from "./contacts/ContactDetail";

interface ContactListItemContact {
  _id: Id<"contacts">;
  displayName: string;
  company?: string | null;
  avatarUrl?: string | null;
  handles: Array<{ type: string; value: string; platform: string }>;
}

interface SwipeableContactListItemProps {
  contact: ContactListItemContact;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onArchive: () => void;
  openSwipeId?: string | null;
  onSwipeActiveChange?: (contactId: string | null) => void;
}

export function SwipeableContactListItem({
  contact,
  selected,
  onClick,
  onArchive,
  openSwipeId = null,
  onSwipeActiveChange,
}: SwipeableContactListItemProps) {
  const uniqueHandles = deduplicateHandles(contact.handles);
  const visibleHandles = uniqueHandles.filter((h) => VISIBLE_HANDLE_TYPES.has(h.type));
  const prioritizedHandles = prioritizeHandles(visibleHandles);
  const displayedHandles = prioritizedHandles.slice(0, 2);
  const platforms = [...new Set(contact.handles.map((h) => h.platform))];

  return (
    <SwipeableListItem
      itemId={contact._id}
      selected={selected}
      onClick={onClick}
      openSwipeId={openSwipeId}
      onSwipeActiveChange={onSwipeActiveChange}
      rightAction={{
        label: "Archive",
        control: (
          <Button
            variant="secondary"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
            }}
            aria-label="Archive contact"
            className={cn(
              "cursor-pointer rounded-full",
              "border border-input bg-background hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <Archive size={16} strokeWidth={1.5} />
          </Button>
        ),
      }}
    >
      <div className="flex items-center gap-3">
        <Avatar size="lg">
          {contact.avatarUrl ? (
            <AvatarImage src={contact.avatarUrl} alt={contact.displayName} />
          ) : null}
          <AvatarFallback>{getInitials(contact.displayName)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <span className="block truncate font-medium text-sm">{contact.displayName}</span>
            </div>
            {contact.company && (
              <span className="mt-0.5 shrink-0 truncate text-xs text-muted-foreground">
                {contact.company}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <div className="flex gap-1">
              {platforms.slice(0, 3).map((platform) => {
                const config = PLATFORM_CONFIG[platform as ActionPlatform];
                return (
                  <Badge
                    key={platform}
                    variant="secondary"
                    className="px-1.5 py-0 text-[10px]"
                    style={config ? { backgroundColor: config.color, color: "white" } : undefined}
                  >
                    <PlatformIcon platform={platform as ActionPlatform} className="h-2.5 w-2.5" />
                  </Badge>
                );
              })}
            </div>
            {displayedHandles.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {displayedHandles.map((handle, i) => (
                  <span key={`${handle.type}-${handle.value}-${i}`} className="flex items-center gap-1">
                    <HandleIcon type={handle.type} />
                    <span className="max-w-[80px] truncate">{handle.value}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </SwipeableListItem>
  );
}
