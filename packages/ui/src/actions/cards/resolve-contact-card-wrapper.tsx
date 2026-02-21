/**
 * Resolve contact card wrapper for resolve_contact actions.
 * Flattens both contacts' handles into a single list for the confirmation UI.
 */

import * as React from "react";
import {
  ResolveContactCard,
  type MergeSource,
  type MergeHandle,
} from "../../components/action-queue/resolve-contact-card";
import type { ActionCardProps } from "../types";
import { buildHandleDeeplink, type ContactHandle } from "@cued/shared";

/** Returns true if the handle value is human-readable (not a raw internal ID). */
function isHumanReadable(handle: { handleType: string; handle: string }): boolean {
  // Slack user IDs: U + uppercase alphanumeric (e.g. U09PTRCMMJQ)
  if (handle.handleType === "slack_id" && /^U[A-Z0-9]+$/.test(handle.handle)) return false
  // LinkedIn URNs: urn:li:... format
  if (handle.handleType === "linkedin_urn") return false
  return true
}

/** Build a MergeHandle from a context handle, using displayName as fallback for raw IDs. */
function toMergeHandle(
  h: { handleType: string; handle: string; platform: string },
  contactDisplayName: string,
): MergeHandle {
  const readable = isHumanReadable(h)
  return {
    type: h.handleType as ContactHandle["type"],
    value: h.handle,
    platform: h.platform as ContactHandle["platform"],
    displayLabel: readable ? undefined : contactDisplayName,
    deeplinkUrl: buildHandleDeeplink(h.platform, h.handleType, h.handle) ?? undefined,
  }
}

/**
 * Resolve contact card for merge actions.
 */
export function ResolveContactCardWrapper({
  action,
  isTop,
  context,
  className,
  onLinkClick,
}: ActionCardProps) {
  const hasContext = isTop && context;
  const { contact, secondaryContact } = context ?? {};

  // Use primary contact name, fall back to action fields
  const name = contact?.displayName ?? action.contactName ?? "Unknown";

  // Flatten handles from both contacts into a single list
  const handles: MergeHandle[] = [];
  if (hasContext) {
    for (const h of contact?.handles ?? []) {
      handles.push(toMergeHandle(h, contact?.displayName ?? name))
    }
    for (const h of secondaryContact?.handles ?? []) {
      handles.push(toMergeHandle(h, secondaryContact?.displayName ?? name))
    }
  }

  return (
    <ResolveContactCard
      name={name}
      avatarUrl={contact?.avatarUrl ?? secondaryContact?.avatarUrl ?? null}
      handles={handles}
      confidence={action.mergeConfidence ?? 0}
      source={(action.mergeSource ?? "email_match") as MergeSource}
      reasoning={action.mergeReasoning}
      className={className}
      onLinkClick={onLinkClick}
    />
  );
}
