/**
 * Action type constants.
 * Canonical source - use these instead of hardcoded strings.
 */

export const ACTION_TYPES = {
  RESPOND: "respond",
  FOLLOW_UP: "follow_up",
  SEND_MESSAGE: "send_message",
  RESOLVE_CONTACT: "resolve_contact",
} as const;

export type ActionType = (typeof ACTION_TYPES)[keyof typeof ACTION_TYPES];

/** Action types that involve responding to messages */
export const MESSAGE_ACTION_TYPES = [
  ACTION_TYPES.RESPOND,
  ACTION_TYPES.FOLLOW_UP,
  ACTION_TYPES.SEND_MESSAGE,
] as const;

/** Action types related to contact management */
export const CONTACT_ACTION_TYPES = [
  ACTION_TYPES.RESOLVE_CONTACT,
] as const;

/** Check if an action type is a message action */
export function isMessageActionType(type: string): boolean {
  return (MESSAGE_ACTION_TYPES as readonly string[]).includes(type);
}

/** Check if an action type is a contact action */
export function isContactActionType(type: string): boolean {
  return (CONTACT_ACTION_TYPES as readonly string[]).includes(type);
}
