import type { ComponentType, ReactNode } from "react"

export type ArtifactActionContext<T = unknown> = {
  data: T
}

export type ArtifactAction<T = unknown> = {
  icon: ReactNode
  label?: string
  description: string
  onClick: (context: ArtifactActionContext<T>) => Promise<void> | void
  isDisabled?: (context: ArtifactActionContext<T>) => boolean
}

export type ArtifactContentProps<T = unknown> = {
  data: T
  isStreaming?: boolean
}

export type ArtifactConfig<K extends string, T = unknown> = {
  kind: K
  description: string
  /** Parse tool result into artifact data, return null if invalid */
  parse: (result: unknown) => T | null
  /** Component to render the artifact */
  content: ComponentType<ArtifactContentProps<T>>
  /** Actions available on this artifact */
  actions?: ArtifactAction<T>[]
  /** Empty state component or message */
  emptyMessage?: string
  /** Icon for the artifact header */
  icon?: ComponentType<{ className?: string }>
}

export class Artifact<K extends string, T = unknown> {
  readonly kind: K
  readonly description: string
  readonly parse: (result: unknown) => T | null
  readonly content: ComponentType<ArtifactContentProps<T>>
  readonly actions: ArtifactAction<T>[]
  readonly emptyMessage: string
  readonly icon?: ComponentType<{ className?: string }>

  constructor(config: ArtifactConfig<K, T>) {
    this.kind = config.kind
    this.description = config.description
    this.parse = config.parse
    this.content = config.content
    this.actions = config.actions || []
    this.emptyMessage = config.emptyMessage || "No results found"
    this.icon = config.icon
  }
}
