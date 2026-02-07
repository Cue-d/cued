import { Building2, Clock, FileText, Tag, User } from "lucide-react";
import { getInitials } from "@cued/shared";
import { PlatformIcon } from "./shared";
import type { DemoPlatform } from "../demo-card-data";

interface DemoContactCardProps {
  personName: string;
  platform: DemoPlatform;
  company: string;
  tags: string[];
  notes: string;
}

export function DemoContactCard({
  personName,
  platform,
  company,
  tags,
  notes,
}: DemoContactCardProps) {
  const initials = getInitials(personName);

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header */}
      <div className="shrink-0 p-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted text-xs font-semibold shadow-sm">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3" />
              <span>You met someone new today</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">
                {personName}
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium shadow-sm ${platformBadgeBg(platform)}`}
              >
                <PlatformIcon platform={platform} className="size-3" />
                {platform}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Form (static) */}
      <div className="flex-1 overflow-hidden px-6 pb-6">
        <p className="mb-4 text-sm text-muted-foreground">
          Tell me a bit more about them so you can remember this connection
          later.
        </p>

        <div className="space-y-4">
          <FormField icon={<User className="size-4" />} label="Name">
            <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm shadow-sm">
              {personName}
            </div>
          </FormField>

          <FormField icon={<Building2 className="size-4" />} label="Company">
            <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm shadow-sm">
              {company}
            </div>
          </FormField>

          <FormField icon={<Tag className="size-4" />} label="Tags">
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md bg-muted/70 px-2.5 py-0.5 text-xs text-foreground shadow-sm"
                >
                  {tag}
                </span>
              ))}
            </div>
          </FormField>

          <FormField icon={<FileText className="size-4" />} label="Notes">
            <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm leading-relaxed text-muted-foreground shadow-sm">
              {notes}
            </div>
          </FormField>
        </div>
      </div>
    </div>
  );
}

function FormField({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {label}
      </div>
      {children}
    </div>
  );
}

function platformBadgeBg(platform: DemoPlatform): string {
  switch (platform) {
    case "imessage":
      return "bg-green-500/10 text-green-600";
    case "gmail":
      return "bg-red-500/10 text-red-600";
    case "slack":
      return "bg-purple-500/10 text-purple-600";
    case "linkedin":
      return "bg-blue-500/10 text-blue-600";
  }
}
