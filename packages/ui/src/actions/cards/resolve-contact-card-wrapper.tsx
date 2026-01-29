/**
 * Resolve contact card wrapper for resolve_contact actions.
 * Delegates to ResolveContactCard with context mapping.
 */

import * as React from "react";
import {
  ResolveContactCard,
  type MergeSource,
} from "../../components/action-queue/resolve-contact-card";
import type { ActionCardProps } from "../types";
import type { ContactHandle } from "@prm/shared";

/**
 * Map context handles to ContactHandle format.
 */
function mapHandles(
  handles:
    | Array<{ handleType: string; handle: string; platform: string }>
    | undefined
): ContactHandle[] {
  if (!handles) return [];
  return handles.map((h) => ({
    type: h.handleType as ContactHandle["type"],
    value: h.handle,
    platform: h.platform as ContactHandle["platform"],
  }));
}

/**
 * Resolve contact card for merge actions.
 */
export function ResolveContactCardWrapper({
  action,
  isTop,
  context,
  className,
}: ActionCardProps) {
  const hasContext = isTop && context;
  const { contact, secondaryContact } = context ?? {};

  return (
    <ResolveContactCard
      contact1={{
        name: contact?.displayName ?? action.contactName ?? "Unknown",
        company: hasContext ? contact?.company : null,
        handles: hasContext ? mapHandles(contact?.handles) : [],
      }}
      contact2={{
        name: secondaryContact?.displayName ?? action.secondaryContactName ?? "Unknown",
        company: hasContext ? secondaryContact?.company : null,
        handles: hasContext ? mapHandles(secondaryContact?.handles) : [],
      }}
      confidence={action.mergeConfidence ?? 0}
      source={(action.mergeSource ?? "email_match") as MergeSource}
      reasoning={action.mergeReasoning}
      className={className}
    />
  );
}
