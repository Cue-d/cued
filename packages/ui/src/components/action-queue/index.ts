export { SnoozePicker } from "./SnoozePicker"
export type { SnoozePickerProps } from "./SnoozePicker"

export { CardStack } from "./CardStack"
export type {
  CardStackProps,
  ActionItem,
  SwipeDirection,
} from "./CardStack"

export { SwipeableCard } from "./swipeable-card"
export type { SwipeableCardProps } from "./swipeable-card"

export { MessageResponseCard } from "./message-response-card"
export type {
  MessageResponseCardProps,
  MessageResponseCardRef,
} from "./message-response-card"

// Re-export shared types from @prm/shared for backwards compatibility
export type {
  DisplayMessage,
  MessageAttachment,
  ActionPlatform,
  DraftOption,
  DraftRiskFlag,
  DraftLabel,
  ContactFormData,
} from "@prm/shared"

export { ContactCard } from "./contact-card"
export type {
  ContactCardProps,
  ContactCardRef,
  ExistingContact,
} from "./contact-card"

export {
  ResolveContactCard,
  ContactPanel,
  SourceBadge,
} from "./resolve-contact-card"
export type {
  ResolveContactCardProps,
  ContactHandle,
  ContactPanelProps,
  MergeSource,
  SourceBadgeProps,
} from "./resolve-contact-card"

export {
  ActionFilterChips,
  ACTION_FILTER_GROUPS,
} from "./action-filter-chips"
export type {
  ActionFilterChipsProps,
  FilterGroup,
} from "./action-filter-chips"
