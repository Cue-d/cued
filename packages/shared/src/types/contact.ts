/**
 * Shared types for contacts and handles.
 * Canonical definitions - import from @prm/shared, don't redefine.
 */

/**
 * Types of contact handles supported across the platform.
 */
export type HandleType =
  | "phone"
  | "email"
  | "slack_id"
  | "username"      // vanity URLs (linkedin)
  | "urn"           // platform URNs (linkedin)
  | "twitter_handle";

/**
 * Platforms that a handle can be associated with.
 */
export type HandlePlatform =
  | "imessage"
  | "gmail"
  | "slack"
  | "linkedin"
  | "twitter";

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
