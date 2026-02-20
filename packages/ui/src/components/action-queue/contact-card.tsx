import * as React from "react";
import { ChevronRight } from "lucide-react";
import { formatTime, getInitials, type ContactFormData } from "@cued/shared";
import { OpenInAppButton } from "./open-in-app-button";
import { cn } from "../../lib/utils";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import type { OpenInAppConfig } from "../../actions/types";

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
  /** Form data state */
  formData: ContactFormData;
  /** Called when form data changes */
  onFormChange: (data: ContactFormData) => void;
  /** Existing contacts for merge dropdown */
  existingContacts?: ExistingContact[];
  /** Optional class name */
  className?: string;
  /** Auto-focus notes textarea on mount */
  autoFocus?: boolean;
  /** Open-in-app deeplink config */
  openInApp?: OpenInAppConfig | null;
  /** When true, disables form inputs (history view) */
  readOnly?: boolean;
}

export interface ContactCardRef {
  focusInput: () => void;
}

/**
 * ContactCard component for action queue.
 * Clean, minimal design focused on quick note capture.
 */
export const ContactCard = React.forwardRef<ContactCardRef, ContactCardProps>(
  function ContactCard(
    {
      personName,
      createdAt,
      formData,
      onFormChange,
      existingContacts = [],
      className,
      autoFocus = true,
      openInApp,
      readOnly = false,
    },
    ref
  ) {
    const notesRef = React.useRef<HTMLTextAreaElement>(null);
    const [detailsOpen, setDetailsOpen] = React.useState(
      () => !!(formData.company || formData.tags)
    );

    React.useImperativeHandle(ref, () => ({
      focusInput: () => notesRef.current?.focus(),
    }));

    React.useEffect(() => {
      if (!autoFocus) return;
      const timer = setTimeout(() => notesRef.current?.focus(), 300);
      return () => clearTimeout(timer);
    }, [autoFocus]);

    const initials = getInitials(personName);
    const meetingTime = createdAt ? formatTime(createdAt) : "earlier";

    const tagList = formData.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    return (
      <div
        className={cn(
          "w-full h-full flex flex-col overflow-hidden",
          className
        )}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center gap-3 px-5 pt-6 pb-4">
          <Avatar>
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate">
              {personName}
            </h3>
            <p className="text-xs text-muted-foreground">
              Met today &middot; {meetingTime}
            </p>
          </div>
          {openInApp && <OpenInAppButton config={openInApp} tooltip="⌘O" />}
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5">
          <p className="text-[13px] text-muted-foreground mb-3">
            What do you remember about them?
          </p>

          {/* Notes — hero field, no label */}
          <Textarea
            ref={notesRef}
            value={formData.notes}
            onChange={(e) =>
              onFormChange({ ...formData, notes: e.target.value })
            }
            placeholder="Where you met, what you talked about, follow-ups..."
            className="min-h-[160px] max-h-[320px] resize-none"
            disabled={readOnly}
            data-selectable="true"
          />

          {/* Collapsible details */}
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setDetailsOpen((prev) => !prev)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronRight
                className={cn(
                  "w-3 h-3 transition-transform",
                  detailsOpen && "rotate-90"
                )}
              />
              Add details
            </button>

            {detailsOpen && (
              <div className="mt-3 space-y-2.5">
                <div data-selectable="true">
                  <label className="text-xs text-muted-foreground mb-1 block">
                    Company
                  </label>
                  <Input
                    value={formData.company}
                    onChange={(e) =>
                      onFormChange({ ...formData, company: e.target.value })
                    }
                    placeholder="Where do they work?"
                    className="h-8 text-sm"
                    disabled={readOnly}
                  />
                </div>

                <div data-selectable="true">
                  <label className="text-xs text-muted-foreground mb-1 block">
                    Tags
                  </label>
                  <Input
                    value={formData.tags}
                    onChange={(e) =>
                      onFormChange({ ...formData, tags: e.target.value })
                    }
                    placeholder="work, friend, investor..."
                    className="h-8 text-sm"
                    disabled={readOnly}
                  />
                  {tagList.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {tagList.map((tag, i) => (
                        <Badge
                          key={i}
                          variant="secondary"
                          className="text-[11px] px-1.5 py-0"
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                {existingContacts.length > 0 && (
                  <div data-selectable="true">
                    <label className="text-xs text-muted-foreground mb-1 block">
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
                      <SelectTrigger className="w-full h-8 text-sm">
                        <SelectValue>Select a contact...</SelectValue>
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
            )}
          </div>
        </div>
      </div>
    );
  }
);

export default ContactCard;
