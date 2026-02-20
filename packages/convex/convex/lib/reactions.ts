import type { Doc, Id } from "../_generated/dataModel";
import { shortcodeToEmoji } from "./emoji";

export interface ReactionGroupResult {
  emoji: string;
  reactors: Array<{
    displayName: string;
    isFromMe: boolean;
  }>;
}

/**
 * Group raw reactions by emoji and resolve reactor display names.
 * Returns null if no reactions.
 */
export function groupReactions(
  reactions: Doc<"messages">["reactions"] | undefined,
  contactNames: Map<string, string> // contactId → displayName
): ReactionGroupResult[] | null {
  if (!Array.isArray(reactions) || reactions.length === 0) return null;

  const groups = new Map<
    string,
    Array<{ displayName: string; isFromMe: boolean }>
  >();

  for (const reaction of reactions) {
    if (!reaction || typeof reaction !== "object") continue;

    const rawEmoji = typeof reaction.emoji === "string" ? reaction.emoji : "";
    if (!rawEmoji || rawEmoji.trim().length === 0) continue;

    const emoji = shortcodeToEmoji(rawEmoji);
    let reactors = groups.get(emoji);
    if (!reactors) {
      reactors = [];
      groups.set(emoji, reactors);
    }

    let displayName: string;
    const isFromMe = reaction.isFromMe === true;
    const contactId =
      typeof reaction.contactId === "string" ? reaction.contactId : null;

    if (isFromMe) {
      displayName = "You";
    } else if (contactId) {
      displayName = contactNames.get(contactId) ?? "Someone";
    } else {
      displayName = "Someone";
    }

    // Avoid duplicate entries (same person, same emoji)
    const alreadyExists = reactors.some(
      (r) =>
        r.displayName === displayName && r.isFromMe === isFromMe
    );
    if (!alreadyExists) {
      reactors.push({ displayName, isFromMe });
    }
  }

  if (groups.size === 0) return null;

  return Array.from(groups.entries()).map(([emoji, reactors]) => ({
    emoji,
    reactors,
  }));
}

/**
 * Collect all unique contactIds from reactions across multiple messages.
 */
export function collectReactionContactIds(
  messages: Array<{ reactions?: Doc<"messages">["reactions"] }>
): Id<"contacts">[] {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.reactions)) continue;
    for (const reaction of msg.reactions) {
      if (!reaction || typeof reaction !== "object") continue;
      if (typeof reaction.contactId === "string") {
        ids.add(reaction.contactId);
      }
    }
  }
  return [...ids] as Id<"contacts">[];
}
