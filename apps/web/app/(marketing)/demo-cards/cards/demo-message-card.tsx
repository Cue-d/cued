import { ArrowUp } from "lucide-react";
import { PlatformIcon, platformColor } from "./shared";
import type { DemoMessage, DemoPlatform } from "../demo-card-data";

interface DemoMessageCardProps {
  personName: string;
  platform: DemoPlatform;
  messages: DemoMessage[];
  draftText: string;
  reason?: string;
}

export function DemoMessageCard({
  personName,
  platform,
  messages,
  draftText,
  reason,
}: DemoMessageCardProps) {
  return (
    <div className="flex h-full w-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-center gap-2 px-6 py-4">
        <span className={platformColor(platform)}>
          <PlatformIcon platform={platform} className="size-4" />
        </span>
        <span className="text-sm font-semibold text-foreground">
          {personName}
        </span>
      </div>

      {/* Messages */}
      <div className="flex flex-1 flex-col justify-end gap-2 overflow-hidden px-6 py-4">
        {reason && (
          <div className="mb-1 self-center">
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm">
              {reason === "follow_up" ? "Follow up" : "Suggested reply"}
            </span>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.isFromMe ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed ${
                msg.isFromMe
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/80 text-foreground"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
      </div>

      {/* Draft response */}
      <div className="shrink-0 px-5 pb-5 pt-2">
        <div className="flex items-end gap-2 rounded-xl bg-muted/40 px-4 py-3 shadow-sm">
          <p className="flex-1 text-[13px] leading-relaxed text-foreground/60 line-clamp-3">
            {draftText}
          </p>
          <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary shadow-sm">
            <ArrowUp className="size-3.5 text-primary-foreground" />
          </div>
        </div>
      </div>
    </div>
  );
}
