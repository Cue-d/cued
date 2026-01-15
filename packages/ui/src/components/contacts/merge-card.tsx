"use client"

import * as React from "react"
import { ArrowRight, Check, Mail, MessageSquare, Phone, X } from "lucide-react"
import { cn } from "../../lib/utils"
import { Card, CardContent, CardHeader } from "../ui/card"
import { Avatar, AvatarFallback } from "../ui/avatar"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"

/** Handle type for contacts */
export interface ContactHandle {
  type: "phone" | "email" | "slack_id"
  value: string
  platform: "imessage" | "gmail" | "slack"
}

/** Contact data for merge comparison */
export interface MergeContact {
  _id: string
  displayName: string
  company?: string | null
  notes?: string | null
  handles: ContactHandle[]
}

/** Merge suggestion data */
export interface MergeSuggestion {
  _id: string
  confidence: number
  source: "email_match" | "phone_match" | "name_match" | "llm_match"
  reasoning?: string | null
}

export interface MergeCardProps {
  /** First contact (will be kept as primary) */
  contact1: MergeContact
  /** Second contact (will be merged into primary) */
  contact2: MergeContact
  /** Merge suggestion details */
  suggestion: MergeSuggestion
  /** Called when user approves the merge */
  onMerge: () => void
  /** Called when user rejects the merge */
  onReject: () => void
  /** Loading state */
  isLoading?: boolean
  /** Optional class name */
  className?: string
}

/** Get initials from a name */
function getInitials(name: string): string {
  if (/^\+?\d/.test(name)) return "#"
  if (name.includes("@")) return name[0].toUpperCase()
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
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
  }
}

/** Get source badge color */
function getSourceColor(source: MergeSuggestion["source"]): string {
  switch (source) {
    case "email_match":
      return "bg-red-500/10 text-red-600 border-red-200"
    case "phone_match":
      return "bg-green-500/10 text-green-600 border-green-200"
    case "name_match":
      return "bg-blue-500/10 text-blue-600 border-blue-200"
    case "llm_match":
      return "bg-purple-500/10 text-purple-600 border-purple-200"
  }
}

/** Contact preview panel */
function ContactPanel({ contact }: { contact: MergeContact }) {
  const initials = getInitials(contact.displayName)

  // Group handles by type
  const phones = contact.handles.filter((h) => h.type === "phone")
  const emails = contact.handles.filter((h) => h.type === "email")
  const slackIds = contact.handles.filter((h) => h.type === "slack_id")

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-3 mb-3">
        <Avatar size="sm">
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <h4 className="font-semibold text-sm truncate">{contact.displayName}</h4>
          {contact.company && (
            <p className="text-xs text-muted-foreground truncate">
              {contact.company}
            </p>
          )}
        </div>
      </div>

      {/* Handles grouped by type */}
      <div className="space-y-2">
        {phones.length > 0 && (
          <div className="space-y-1">
            {phones.map((handle, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <HandleIcon type={handle.type} />
                <span className="truncate flex-1">{handle.value}</span>
                <Badge
                  variant="outline"
                  className={cn("text-[10px] px-1", getPlatformColor(handle.platform))}
                >
                  {handle.platform}
                </Badge>
              </div>
            ))}
          </div>
        )}
        {emails.length > 0 && (
          <div className="space-y-1">
            {emails.map((handle, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <HandleIcon type={handle.type} />
                <span className="truncate flex-1">{handle.value}</span>
                <Badge
                  variant="outline"
                  className={cn("text-[10px] px-1", getPlatformColor(handle.platform))}
                >
                  {handle.platform}
                </Badge>
              </div>
            ))}
          </div>
        )}
        {slackIds.length > 0 && (
          <div className="space-y-1">
            {slackIds.map((handle, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <HandleIcon type={handle.type} />
                <span className="truncate flex-1">{handle.value}</span>
                <Badge
                  variant="outline"
                  className={cn("text-[10px] px-1", getPlatformColor(handle.platform))}
                >
                  {handle.platform}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Notes preview */}
      {contact.notes && (
        <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
          {contact.notes}
        </p>
      )}
    </div>
  )
}

/**
 * MergeCard component for contact merge review.
 * Shows two contacts side-by-side with all their handles for comparison.
 */
export function MergeCard({
  contact1,
  contact2,
  suggestion,
  onMerge,
  onReject,
  isLoading = false,
  className,
}: MergeCardProps) {
  const confidencePercent = Math.round(suggestion.confidence * 100)

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Possible duplicate</span>
            <Badge
              variant="outline"
              className={cn("text-xs", getSourceColor(suggestion.source))}
            >
              {suggestion.source.replace("_", " ")}
            </Badge>
          </div>
          <Badge variant="secondary" className="text-xs">
            {confidencePercent}% match
          </Badge>
        </div>
        {suggestion.reasoning && (
          <p className="text-xs text-muted-foreground mt-1">
            {suggestion.reasoning}
          </p>
        )}
      </CardHeader>

      <CardContent className="pt-2">
        {/* Side-by-side comparison */}
        <div className="flex gap-4 items-start">
          <ContactPanel contact={contact1} />

          <div className="flex flex-col items-center justify-center py-4">
            <ArrowRight className="w-4 h-4 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground mt-1">merge</span>
          </div>

          <ContactPanel contact={contact2} />
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 mt-4 pt-4 border-t">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={onReject}
            disabled={isLoading}
          >
            <X className="w-4 h-4 mr-1" />
            Different people
          </Button>
          <Button
            size="sm"
            className="flex-1"
            onClick={onMerge}
            disabled={isLoading}
          >
            <Check className="w-4 h-4 mr-1" />
            Merge contacts
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default MergeCard
