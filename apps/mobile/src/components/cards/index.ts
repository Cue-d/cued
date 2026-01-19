/**
 * Card components barrel export for mobile action queue.
 *
 * Task 6.5: Export all card components and related types.
 */

// MessageResponseCard
export {
  MessageResponseCard,
  type MessageResponseCardProps,
} from "./message-response-card";

// ContactCard
export {
  ContactCard,
  type ContactPlatform,
  type ContactCardProps,
} from "./contact-card";

// Re-export shared types from @prm/shared for backwards compatibility
export type {
  ActionPlatform,
  MessageAttachment,
  DisplayMessage,
  DraftOption,
  DraftRiskFlag,
  ContactFormData,
} from "@prm/shared";
