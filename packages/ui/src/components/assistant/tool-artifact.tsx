"use client"

import * as React from "react"

import { cn } from "../../lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui/tooltip"
import {
  artifactDefinitions,
  type ArtifactKind,
  parseToolResult,
} from "./artifacts"

export type { ArtifactKind }

interface ToolArtifactProps {
  toolName: string
  result: unknown
  className?: string
}

function ArtifactHeader({
  artifact,
  data,
}: {
  artifact: (typeof artifactDefinitions)[number]
  data: unknown
}) {
  const Icon = artifact.icon
  const isEmpty = Array.isArray(data) ? data.length === 0 : !data

  if (isEmpty) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {Icon && <Icon className="size-4" />}
        <span>{artifact.emptyMessage}</span>
      </div>
    )
  }

  const count = Array.isArray(data) ? data.length : 1
  const label = Array.isArray(data)
    ? `${count} ${artifact.description.toLowerCase()}`
    : artifact.description

  return (
    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
      {Icon && <Icon className="size-3" />}
      <span>{label}</span>
    </div>
  )
}

function ArtifactActions({
  artifact,
  data,
}: {
  artifact: (typeof artifactDefinitions)[number]
  data: unknown
}) {
  if (!artifact.actions || artifact.actions.length === 0) {
    return null
  }

  return (
    <div className="flex items-center gap-1">
      {artifact.actions.map((action, index) => {
        // Cast to any to avoid complex union type issues with isDisabled
        const isDisabled = action.isDisabled?.({ data } as any) ?? false

        return (
          <Tooltip key={index}>
            <TooltipTrigger
              disabled={isDisabled}
              onClick={() => action.onClick({ data } as any)}
              className={cn(
                "flex size-6 items-center justify-center rounded-md transition-colors",
                "text-muted-foreground hover:bg-muted hover:text-foreground",
                "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              )}
            >
              {action.icon}
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {action.description}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

export function ToolArtifact({ toolName, result, className }: ToolArtifactProps) {
  const parsed = React.useMemo(
    () => parseToolResult(toolName, result),
    [toolName, result]
  )

  if (!parsed) {
    return null
  }

  const { artifact, data } = parsed
  const Content = artifact.content as React.ComponentType<{ data: unknown }>
  const isEmpty = Array.isArray(data) ? data.length === 0 : !data

  return (
    <div className={cn("mt-3 space-y-2", className)}>
      <div className="flex items-center justify-between">
        <ArtifactHeader artifact={artifact} data={data} />
        {!isEmpty && <ArtifactActions artifact={artifact} data={data} />}
      </div>
      {!isEmpty && <Content data={data} />}
    </div>
  )
}
