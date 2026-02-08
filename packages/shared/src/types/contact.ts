/**
 * Shared types for contacts and handles.
 * Canonical definitions - import from @cued/shared, don't redefine.
 */

/**
 * Types of contact handles supported across the platform.
 *
 * @remarks
 * Platform-specific mappings:
 * - `phone` - E.164 phone numbers (iMessage, WhatsApp)
 * - `email` - Email addresses (Gmail, iMessage)
 * - `slack_id` - Slack user IDs (format: UXXXXXXXX)
 * - `signal_id` - Signal protocol identifiers (UUIDs, normalized to lowercase)
 * - `linkedin_handle` - LinkedIn vanity URLs (linkedin.com/in/username)
 * - `linkedin_urn` - LinkedIn URNs (format: urn:li:member:123456)
 * - `twitter_handle` - Twitter/X usernames (@handle)
 * - `twitter_user_id` - Twitter/X numeric user IDs
 */
export type HandleType =
  | "phone"
  | "email"
  | "slack_id"
  | "signal_id"
  | "linkedin_handle"
  | "linkedin_urn"
  | "twitter_handle"
  | "twitter_user_id";

/**
 * Platforms that a handle can be associated with.
 */
export type HandlePlatform =
  | "imessage"
  | "gmail"
  | "slack"
  | "linkedin"
  | "twitter"
  | "signal";

/**
 * A contact handle (phone, email, social ID, etc.)
 * Used across UI, AI, and sync packages.
 */
export interface ContactHandle {
  /** Type of handle */
  type: HandleType;
  /** The handle value (phone number, email, etc.) */
  value: string;
  /** Platform this handle is associated with */
  platform: HandlePlatform;
}

/**
 * Input type for creating/updating contact handles.
 * Platform is inferred from context in sync operations.
 */
export interface ContactHandleInput {
  /** Type of handle */
  type: HandleType;
  /** The handle value */
  value: string;
}
