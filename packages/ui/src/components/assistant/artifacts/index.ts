export { Artifact } from "./create-artifact"
export type {
  ArtifactAction,
  ArtifactActionContext,
  ArtifactConfig,
  ArtifactContentProps,
} from "./create-artifact"

export { searchMessagesArtifact } from "./search-messages"
export type { SearchResult } from "./search-messages"

export { contactsArtifact } from "./contacts"
export type { ContactResult } from "./contacts"

export { conversationsArtifact } from "./conversations"
export type { ConversationResult } from "./conversations"

export { actionCreatedArtifact } from "./action-created"
export type { ActionResult } from "./action-created"

export { memoriesArtifact } from "./memories"
export type { MemoryResult } from "./memories"

export { actionsArtifact } from "./actions"
export type { ActionSearchResult } from "./actions"

import { actionCreatedArtifact } from "./action-created"
import { actionsArtifact } from "./actions"
import { contactsArtifact } from "./contacts"
import { conversationsArtifact } from "./conversations"
import { memoriesArtifact } from "./memories"
import { searchMessagesArtifact } from "./search-messages"

/** Registry of all artifact definitions */
export const artifactDefinitions = [
  searchMessagesArtifact,
  contactsArtifact,
  conversationsArtifact,
  actionCreatedArtifact,
  memoriesArtifact,
  actionsArtifact,
] as const

/** Union of all artifact kinds */
export type ArtifactKind = (typeof artifactDefinitions)[number]["kind"]

/** Get artifact definition by tool name */
export function getArtifactByKind(kind: string) {
  return artifactDefinitions.find((a) => a.kind === kind)
}

/** Parse a tool result using the appropriate artifact */
export function parseToolResult(toolName: string, result: unknown) {
  const artifact = getArtifactByKind(toolName)
  if (!artifact) return null

  const data = artifact.parse(result)
  if (data === null) return null

  return {
    kind: artifact.kind,
    data,
    artifact,
  }
}
