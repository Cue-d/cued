"use client"

import * as React from "react"
import { AlertTriangle, Sparkles } from "lucide-react"
import { type DraftOption, type DraftLabel } from "@prm/shared"
import { cn } from "../../../lib/utils"
import { Badge } from "../../ui/badge"

/** Label config for draft options */
const labelConfig: Record<DraftLabel, { label: string; colorClass: string }> = {
  direct: { label: "Direct", colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  diplomatic: { label: "Diplomatic", colorClass: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  boundary: { label: "Decline", colorClass: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200" },
}

/** Draft option button component */
export function DraftOptionButton({
  option,
  index,
  onSelect,
}: {
  option: DraftOption
  index: number
  onSelect: (option: DraftOption, index: number) => void
}) {
  const config = labelConfig[option.label]
  const hasRiskFlags = option.riskFlags.length > 0

  return (
    <button
      type="button"
      onClick={() => onSelect(option, index)}
      className={cn(
        "w-full text-left p-3 rounded-lg border bg-card hover:bg-accent transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <Badge variant="secondary" className={cn("text-xs font-medium", config.colorClass)}>
              {config.label}
            </Badge>
            {hasRiskFlags && (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            )}
          </div>
          <p className="text-sm text-foreground line-clamp-2">{option.text}</p>
        </div>
      </div>
      {hasRiskFlags && (
        <div className="mt-2 pt-2 border-t">
          {option.riskFlags.slice(0, 2).map((flag, i) => (
            <p key={i} className="text-xs text-amber-600 dark:text-amber-400">
              {flag.type}: &quot;{flag.trigger}&quot;
            </p>
          ))}
        </div>
      )}
    </button>
  )
}

export interface DraftSelectorProps {
  /** Draft options to display */
  draftOptions: DraftOption[]
  /** Called when a draft option is selected */
  onOptionSelect: (option: DraftOption, index: number) => void
}

/**
 * DraftSelector component - displays AI-generated draft reply options.
 */
export function DraftSelector({
  draftOptions,
  onOptionSelect,
}: DraftSelectorProps) {
  return (
    <div className="px-4 pb-2">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Suggested replies</span>
      </div>
      <div className="space-y-2">
        {draftOptions.map((option, index) => (
          <DraftOptionButton
            key={index}
            option={option}
            index={index}
            onSelect={onOptionSelect}
          />
        ))}
      </div>
    </div>
  )
}

export default DraftSelector
