"use client";

import { useCallback, useRef } from "react";
import { Search, MessageSquare, Mail, Hash, Linkedin } from "lucide-react";
import { InboxConversationItem } from "./conversation-item";
import { cn } from "../../lib/utils";
import type { InboxConversation, InboxPlatform } from "./types";

type PlatformFilter = InboxPlatform | "all";

interface InboxConversationListProps {
  conversations: InboxConversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  className?: string;
  /** Current platform filter */
  platformFilter?: PlatformFilter;
  /** Called when filter changes */
  onFilterChange?: (platform: PlatformFilter) => void;
}

const filterButtons: Array<{ value: PlatformFilter; label: string; icon?: React.ReactNode }> = [
  { value: "all", label: "All" },
  { value: "imessage", label: "iMessage", icon: <MessageSquare className="w-3.5 h-3.5" /> },
  { value: "gmail", label: "Gmail", icon: <Mail className="w-3.5 h-3.5" /> },
  { value: "slack", label: "Slack", icon: <Hash className="w-3.5 h-3.5" /> },
  { value: "linkedin", label: "LinkedIn", icon: <Linkedin className="w-3.5 h-3.5" /> },
];

export function InboxConversationList({
  conversations,
  selectedId,
  onSelect,
  onLoadMore,
  hasMore,
  loading,
  className,
  platformFilter = "all",
  onFilterChange,
}: InboxConversationListProps): React.ReactElement {
  const loadingRef = useRef(false);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!onLoadMore || !hasMore || loading || loadingRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
      const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;

      if (scrollPercentage > 0.8) {
        loadingRef.current = true;
        onLoadMore();
        setTimeout(() => {
          loadingRef.current = false;
        }, 500);
      }
    },
    [onLoadMore, hasMore, loading]
  );

  return (
    <div
      className={cn(
        "w-80 min-w-80 shrink-0 h-full min-h-0 bg-sidebar flex flex-col border-r border-sidebar-border",
        className
      )}
    >
      {/* Search */}
      <div className="px-4 py-3">
        <div className="relative group">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none transition-colors group-focus-within:text-primary" />
          <input
            type="text"
            placeholder="Search conversations..."
            className="w-full h-10 pl-10 pr-4 rounded-xl bg-muted/60 text-foreground placeholder:text-muted-foreground/70 text-sm transition-all duration-200 border border-transparent focus:outline-none focus:bg-background focus:border-primary/20"
          />
        </div>
      </div>

      {/* Platform Filter */}
      {onFilterChange && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          {filterButtons.map((btn) => (
            <button
              key={btn.value}
              type="button"
              onClick={() => onFilterChange(btn.value)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all",
                platformFilter === btn.value
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {btn.icon}
              {btn.label}
            </button>
          ))}
        </div>
      )}

      {/* Conversation list */}
      <div
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-3"
      >
        {conversations.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground text-sm gap-2">
            <div className="w-12 h-12 rounded-2xl bg-muted/50 flex items-center justify-center">
              <Search className="w-5 h-5 text-muted-foreground/50" />
            </div>
            <span>No conversations yet</span>
          </div>
        ) : (
          <div className="space-y-1">
            {conversations.map((conversation) => (
              <InboxConversationItem
                key={conversation._id}
                conversation={conversation}
                isSelected={selectedId === conversation._id}
                onClick={() => onSelect(conversation._id)}
              />
            ))}
            {loading && (
              <div className="flex items-center justify-center py-6">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  <span>Loading...</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
