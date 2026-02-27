/**
 * Action Registry - Core types and registry pattern.
 * Defines metadata and validation for each action type.
 */

/**
 * Icon specification for cross-platform rendering.
 * Web uses lucide-react icon names, mobile uses SF Symbols.
 */
export interface ActionIcon {
  /** lucide-react icon name for web */
  web: string;
  /** SF Symbol name for iOS */
  mobile: string;
}

/**
 * Swipe labels for action gestures.
 */
export interface SwipeLabels {
  /** Label for right swipe (confirm/send) */
  right: string;
  /** Label for left swipe (discard/reject) */
  left: string;
  /** Label for up swipe (snooze) */
  up: string;
}

/**
 * Action metadata - describes an action type without implementation details.
 * This is the shared contract used across frontend, backend, and mobile.
 */
export interface ActionMetadata<TInput = unknown> {
  /** Unique action type identifier */
  type: string;
  /** Human-readable display name */
  displayName: string;
  /** Category for grouping/filtering */
  category: "message" | "contact";
  /** Icons for different platforms */
  icon: ActionIcon;
  /** Labels shown during swipe gestures */
  swipeLabels: SwipeLabels;
  /** Whether this action type uses a response text input */
  hasResponseInput: boolean;
  /** Whether this action type uses a contact form */
  hasContactForm: boolean;
  /** Default input value if applicable */
  defaultInput?: TInput;
}

/**
 * Validation context for action input.
 * Passed to validators for context-aware validation.
 */
export interface ValidationContext {
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** Platform the action is for */
  platform?: string;
}

/**
 * Full action definition including metadata and optional validation.
 */
export interface ActionDefinition<TInput = unknown> {
  /** Action metadata */
  metadata: ActionMetadata<TInput>;
  /** Optional input validator - returns error message or null if valid */
  validateInput?: (input: TInput, ctx: ValidationContext) => string | null;
}

// ============================================================================
// Input Types for Each Action
// ============================================================================

/** Input for respond/follow_up/send_message actions */
export interface MessageResponseInput {
  responseText: string;
}

/** Input for resolve_contact action */
export interface ResolveContactInput {
  confirmed: boolean;
}

// ============================================================================
// Action Definitions
// ============================================================================

export const respondDefinition: ActionDefinition<MessageResponseInput> = {
  metadata: {
    type: "respond",
    displayName: "Respond",
    category: "message",
    icon: { web: "reply", mobile: "arrowshape.turn.up.left" },
    swipeLabels: { right: "Send", left: "Discard", up: "Snooze" },
    hasResponseInput: true,
    hasContactForm: false,
  },
};

export const followUpDefinition: ActionDefinition<MessageResponseInput> = {
  metadata: {
    type: "follow_up",
    displayName: "Follow Up",
    category: "message",
    icon: { web: "clock", mobile: "clock.arrow.circlepath" },
    swipeLabels: { right: "Send", left: "Skip", up: "Snooze" },
    hasResponseInput: true,
    hasContactForm: false,
  },
};

export const sendMessageDefinition: ActionDefinition<MessageResponseInput> = {
  metadata: {
    type: "send_message",
    displayName: "Send Message",
    category: "message",
    icon: { web: "send", mobile: "paperplane" },
    swipeLabels: { right: "Send", left: "Cancel", up: "Snooze" },
    hasResponseInput: true,
    hasContactForm: false,
  },
};

export const resolveContactDefinition: ActionDefinition<ResolveContactInput> = {
  metadata: {
    type: "resolve_contact",
    displayName: "Merge Contacts",
    category: "contact",
    icon: { web: "git-merge", mobile: "person.2.wave.2" },
    swipeLabels: { right: "Merge", left: "Different", up: "Snooze" },
    hasResponseInput: false,
    hasContactForm: false,
  },
};

// ============================================================================
// Registry
// ============================================================================

/**
 * Main action registry - maps action type to its definition.
 */
export const ACTION_REGISTRY = {
  respond: respondDefinition,
  follow_up: followUpDefinition,
  send_message: sendMessageDefinition,
  resolve_contact: resolveContactDefinition,
} as const;

export type ActionRegistryType = typeof ACTION_REGISTRY;
export type RegisteredActionType = keyof ActionRegistryType;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get metadata for an action type.
 * Returns undefined if action type is not registered.
 */
export function getActionMetadata(
  type: string
): ActionMetadata<unknown> | undefined {
  const definition = ACTION_REGISTRY[type as RegisteredActionType];
  return definition?.metadata;
}

/**
 * Get the full action definition for a type.
 * Note: Returns the definition with unknown input type for type safety.
 */
export function getActionDefinition(
  type: string
): (typeof ACTION_REGISTRY)[RegisteredActionType] | undefined {
  return ACTION_REGISTRY[type as RegisteredActionType];
}

/**
 * Check if an action type is a message action.
 */
export function isMessageAction(type: string): boolean {
  const metadata = getActionMetadata(type);
  return metadata?.category === "message";
}

/**
 * Check if an action type is a contact action.
 */
export function isContactAction(type: string): boolean {
  const metadata = getActionMetadata(type);
  return metadata?.category === "contact";
}

/**
 * Get all action types of a specific category.
 */
export function getActionTypesByCategory(
  category: "message" | "contact"
): string[] {
  return Object.entries(ACTION_REGISTRY)
    .filter(([, def]) => def.metadata.category === category)
    .map(([type]) => type);
}

/**
 * Get all registered action types.
 */
export function getAllActionTypes(): string[] {
  return Object.keys(ACTION_REGISTRY);
}

/**
 * Get swipe labels for an action type.
 */
export function getSwipeLabels(type: string): SwipeLabels | undefined {
  return getActionMetadata(type)?.swipeLabels;
}

/**
 * Check if action type has response input.
 */
export function hasResponseInput(type: string): boolean {
  return getActionMetadata(type)?.hasResponseInput ?? false;
}

/**
 * Check if action type has contact form.
 */
export function hasContactForm(type: string): boolean {
  return getActionMetadata(type)?.hasContactForm ?? false;
}
