import { ArrowLeftRight } from "lucide-react";
import { getInitials } from "@cued/shared";
import { PlatformBadge } from "./shared";
import type { DemoContact } from "../demo-card-data";

interface DemoResolveCardProps {
  contact1: DemoContact;
  contact2: DemoContact;
  confidence: number;
  source: string;
  reasoning: string;
}

function sourceBadgeStyle(source: string): string {
  switch (source) {
    case "email_match":
      return "bg-red-500/10 text-red-600";
    case "phone_match":
      return "bg-green-500/10 text-green-600";
    case "exact_name_match":
      return "bg-blue-500/10 text-blue-600";
    case "fuzzy_name_match":
      return "bg-amber-500/10 text-amber-600";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function sourceLabel(source: string): string {
  switch (source) {
    case "email_match":
      return "Email";
    case "phone_match":
      return "Phone";
    case "exact_name_match":
      return "Exact name";
    case "fuzzy_name_match":
      return "Fuzzy name";
    default:
      return source;
  }
}

function ContactPanel({ contact }: { contact: DemoContact }) {
  const initials = getInitials(contact.name);

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-3 flex items-center gap-2.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold shadow-sm">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{contact.name}</p>
          {contact.company && (
            <p className="truncate text-xs text-muted-foreground">
              {contact.company}
            </p>
          )}
        </div>
      </div>
      {contact.handles.length > 0 && (
        <div className="space-y-1.5">
          {contact.handles.map((handle, i) => (
            <div
              key={i}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <PlatformBadge platform={handle.platform} />
              <span className="truncate">{handle.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DemoResolveCard({
  contact1,
  contact2,
  confidence,
  source,
  reasoning,
}: DemoResolveCardProps) {
  const confidencePercent = Math.round(confidence * 100);

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header */}
      <div className="shrink-0 px-8 pt-7 pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Possible duplicate</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium shadow-sm ${sourceBadgeStyle(source)}`}
            >
              {sourceLabel(source)}
            </span>
          </div>
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium shadow-sm">
            {confidencePercent}% match
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground line-clamp-2">
          {reasoning}
        </p>
      </div>

      {/* Side-by-side comparison */}
      <div className="flex flex-1 items-start gap-3 px-8 py-4">
        <ContactPanel contact={contact1} />
        <div className="flex shrink-0 items-center justify-center py-4">
          <ArrowLeftRight className="size-4 text-muted-foreground/50" />
        </div>
        <ContactPanel contact={contact2} />
      </div>
    </div>
  );
}
