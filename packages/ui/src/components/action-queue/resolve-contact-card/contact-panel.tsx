"use client"

import { useState } from "react"
import { ChevronDown, ChevronUp, Linkedin, Mail, MessageSquare, Phone, Twitter, User } from "lucide-react"
import { getInitials, type ContactHandle } from "@cued/shared"
import { cn } from "../../../lib/utils"
import { Avatar, AvatarFallback } from "../../ui/avatar"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"

export interface ContactPanelProps {
  name: string
  company?: string | null
  handles: ContactHandle[]
  className?: string
}

/** Get platform badge color */
function getPlatformColor(platform: string): string {
  switch (platform.toLowerCase()) {
    case "imessage":
      return "bg-green-500/10 text-green-600 border-green-200"
    case "gmail":
      return "bg-red-500/10 text-red-600 border-red-200"
    case "slack":
      return "bg-purple-500/10 text-purple-600 border-purple-200"
    case "linkedin":
      return "bg-blue-500/10 text-blue-600 border-blue-200"
    case "twitter":
      return "bg-sky-500/10 text-sky-600 border-sky-200"
    default:
      return "bg-muted text-muted-foreground"
  }
}

/** Get icon for handle type */
function HandleIcon({ type }: { type: ContactHandle["type"] }) {
  switch (type) {
    case "phone":
      return <Phone className="w-3 h-3" />
    case "email":
      return <Mail className="w-3 h-3" />
    case "slack_id":
      return <MessageSquare className="w-3 h-3" />
    case "linkedin_handle":
    case "linkedin_urn":
      return <Linkedin className="w-3 h-3" />
    case "twitter_handle":
      return <Twitter className="w-3 h-3" />
    default:
      return <User className="w-3 h-3" />
  }
}

/** Render a single handle */
function HandleRow({ handle }: { handle: ContactHandle }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <HandleIcon type={handle.type} />
      <span className="truncate flex-1">{handle.value}</span>
      <Badge
        variant="outline"
        className={cn("text-[10px] px-1", getPlatformColor(handle.platform))}
      >
        {handle.platform}
      </Badge>
    </div>
  )
}

export function ContactPanel({ name, company, handles, className }: ContactPanelProps) {
  const initials = getInitials(name)
  const [expanded, setExpanded] = useState(false)

  // Show first 2 handles collapsed, all when expanded
  const visibleHandles = expanded ? handles : handles.slice(0, 2)
  const hasMore = handles.length > 2

  return (
    <div className={cn("flex-1 min-w-0", className)}>
      <div className="flex items-center gap-3 mb-2">
        <Avatar size="sm">
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <h4 className="font-semibold text-sm truncate">{name}</h4>
          {company ? (
            <p className="text-xs text-muted-foreground truncate">{company}</p>
          ) : null}
        </div>
      </div>

      {/* Handles list */}
      {visibleHandles.length > 0 ? (
        <div className="space-y-1 mt-2">
          {visibleHandles.map((handle, i) => (
            <HandleRow key={`${handle.type}-${handle.value}-${i}`} handle={handle} />
          ))}
        </div>
      ) : null}

      {/* Expand/collapse button */}
      {hasMore ? (
        <Button
          variant="ghost"
          size="sm"
          className="w-full h-6 text-xs mt-1"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <>
              <ChevronUp className="w-3 h-3 mr-1" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="w-3 h-3 mr-1" />
              {handles.length - 2} more
            </>
          )}
        </Button>
      ) : null}
    </div>
  )
}
