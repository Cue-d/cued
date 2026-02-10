import { Building2, FileText, Tag, User } from "lucide-react";
import { getInitials } from "@cued/shared";
import { PlatformBadge } from "./shared";
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
      <div className="shrink-0 px-8 pt-7 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted text-xs font-semibold shadow-sm">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>New contact</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">
                {personName}
              </span>
              <PlatformBadge platform={platform} />
            </div>
          </div>
        </div>
      </div>

      {/* Form (static) */}
      <div className="flex-1 overflow-hidden px-8 pb-7">
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
