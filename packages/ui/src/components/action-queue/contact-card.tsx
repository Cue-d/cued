"use client";

import * as React from "react";
import { Building2, Clock, FileText, Link, Tag, User } from "lucide-react";
import { getInitials, type ContactFormData } from "@prm/shared";
import { cn } from "../../lib/utils";
import { Card, CardContent, CardHeader } from "../ui/card";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

/** Re-export ContactFormData for backwards compatibility */
export type { ContactFormData } from "@prm/shared";

/** Existing contact for linking dropdown */
export interface ExistingContact {
  id: string;
  name: string;
  company?: string | null;
}

export interface ContactCardProps {
  /** Person name for display */
  personName: string;
  /** When the contact was first seen */
  createdAt?: number;
  /** Platform where contact originated */
  platform?: string | null;
  /** Form data state */
  formData: ContactFormData;
  /** Called when form data changes */
  onFormChange: (data: ContactFormData) => void;
  /** Existing contacts for merge dropdown */
  existingContacts?: ExistingContact[];
  /** Optional class name */
  className?: string;
  /** Auto-focus name input on mount */
  autoFocus?: boolean;
}

export interface ContactCardRef {
  focusInput: () => void;
}

/** Format timestamp to time string */
function formatMeetingTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Platform badge color mapping */
function getPlatformColor(platform: string | null | undefined): string {
  switch (platform?.toLowerCase()) {
    case "imessage":
      return "bg-green-500/10 text-green-600 border-green-200";
    case "gmail":
    case "email":
      return "bg-red-500/10 text-red-600 border-red-200";
    case "slack":
      return "bg-purple-500/10 text-purple-600 border-purple-200";
    default:
      return "bg-muted text-muted-foreground";
  }
}

/**
 * ContactCard component for action queue.
 * Displays editable contact information with name, company, tags, notes.
 */
export const ContactCard = React.forwardRef<ContactCardRef, ContactCardProps>(
  function ContactCard(
    {
      personName,
      createdAt,
      platform,
      formData,
      onFormChange,
      existingContacts = [],
      className,
      autoFocus = true,
    },
    ref
  ) {
    const nameInputRef = React.useRef<HTMLInputElement>(null);

    React.useImperativeHandle(ref, () => ({
      focusInput: () => {
        nameInputRef.current?.focus();
      },
    }));

    React.useEffect(() => {
      if (!autoFocus) return;
      const timer = setTimeout(() => {
        nameInputRef.current?.focus();
      }, 300);
      return () => clearTimeout(timer);
    }, [autoFocus]);

    const initials = getInitials(personName);
    const meetingTime = createdAt ? formatMeetingTime(createdAt) : "earlier";

    // Parse tags from comma-separated string
    const tagList = formData.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    return (
      <Card
        className={cn(
          "w-full h-full flex flex-col overflow-hidden gap-0 border-0 p-0",
          className
        )}
      >
        {/* Header */}
        <CardHeader className="shrink-0 p-4">
          <div className="flex items-center gap-x-3">
            <Avatar size="sm">
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Clock className="w-3 h-3" />
                <span>You met someone new today</span>
              </div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm text-foreground truncate">
                  {personName}
                </h3>
                {platform && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] px-1.5 py-0",
                      getPlatformColor(platform)
                    )}
                  >
                    {platform}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">at {meetingTime}</p>
            </div>
          </div>
        </CardHeader>

        {/* Form Content */}
        <CardContent className="flex-1 p-0 min-h-0">
          <div
            className="h-full overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-border/50 [scrollbar-width:thin]"
            style={{ scrollbarColor: "rgba(128, 128, 128, 0.5) transparent" }}
          >
            <div className="py-6 px-4 space-y-5">
              <p className="text-muted-foreground text-sm">
                Tell me a bit more about them so you can remember this
                connection later.
              </p>

              {/* Name Field */}
              <div className="space-y-2" data-selectable="true">
                <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <User className="w-4 h-4 text-muted-foreground" />
                  Name
                </label>
                <Input
                  ref={nameInputRef}
                  value={formData.name}
                  onChange={(e) =>
                    onFormChange({ ...formData, name: e.target.value })
                  }
                  placeholder="Their name..."
                  className="bg-background"
                />
              </div>

              {/* Company Field */}
              <div className="space-y-2" data-selectable="true">
                <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Building2 className="w-4 h-4 text-muted-foreground" />
                  Company
                </label>
                <Input
                  value={formData.company}
                  onChange={(e) =>
                    onFormChange({ ...formData, company: e.target.value })
                  }
                  placeholder="Where do they work?"
                  className="bg-background"
                />
              </div>

              {/* Tags Field */}
              <div className="space-y-2" data-selectable="true">
                <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Tag className="w-4 h-4 text-muted-foreground" />
                  Tags
                </label>
                <Input
                  value={formData.tags}
                  onChange={(e) =>
                    onFormChange({ ...formData, tags: e.target.value })
                  }
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
              <div className="space-y-2" data-selectable="true">
                <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <FileText className="w-4 h-4 text-muted-foreground" />
                  Notes
                </label>
                <Textarea
                  value={formData.notes}
                  onChange={(e) =>
                    onFormChange({ ...formData, notes: e.target.value })
                  }
                  placeholder="Where did you meet? What did you talk about? Any follow-ups?"
                  className="min-h-[100px] max-h-[200px] resize-none bg-background"
                />
              </div>

              {/* Link to Existing Contact */}
              {existingContacts.length > 0 && (
                <div className="space-y-2" data-selectable="true">
                  <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Link className="w-4 h-4 text-muted-foreground" />
                    Link to existing contact
                  </label>
                  <Select
                    value={formData.linkedContactId ?? ""}
                    onValueChange={(value) =>
                      onFormChange({
                        ...formData,
                        linkedContactId: value || null,
                      })
                    }
                  >
                    <SelectTrigger className="bg-background w-full">
                      <SelectValue>Select a contact to merge...</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {existingContacts.map((contact) => (
                        <SelectItem key={contact.id} value={contact.id}>
                          {contact.name}
                          {contact.company && (
                            <span className="text-muted-foreground ml-1">
                              ({contact.company})
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }
);

export default ContactCard;
