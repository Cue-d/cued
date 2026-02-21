import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { resolveMergeArtifactsForContactMerge } from "./mergeResolution";
import { normalizeHandleValue } from "./normalizeHandle";
import {
  areContactAvatarOptionsEqual,
  buildPrimaryAvatarFields,
  getContactAvatarOptions,
  upsertContactAvatarOption,
} from "./avatar";

const MAX_MERGE_AUDIT_MESSAGE_IDS = 2000;

export type ContactMergeSource = Doc<"mergeSuggestions">["source"];

export type MergeFieldResolutions = {
  displayName?: "primary" | "secondary";
  company?: "primary" | "secondary";
  notes?: "primary" | "secondary" | "merge";
};

export type MergePrimaryFieldChanges = Partial<{
  displayName: { before: string; after: string };
  company: { before?: string; after?: string };
  notes: { before?: string; after?: string };
  importance: { before?: number; after?: number };
  tags: { before?: string[]; after?: string[] };
}>;

export type MergeDedupedHandleSnapshot = {
  handleId: Id<"contactHandles">;
  handleType: Doc<"contactHandles">["handleType"];
  handle: string;
  platform: Doc<"contactHandles">["platform"];
  mergedIntoHandleId: Id<"contactHandles">;
};

export type MergeConversationSnapshot = {
  conversationId: Id<"conversations">;
  hadPrimaryBeforeMerge: boolean;
};

export interface ExecuteContactMergeArgs {
  userId: Id<"users">;
  primaryContact: Doc<"contacts">;
  secondaryContact: Doc<"contacts">;
  primaryContactId: Id<"contacts">;
  secondaryContactId: Id<"contacts">;
  actor: "user" | "auto_merge";
  fieldResolutions?: MergeFieldResolutions;
  source?: ContactMergeSource;
  reasoning?: string;
}

export interface ExecuteContactMergeResult {
  handlesMovedCount: number;
  conversationsUpdatedCount: number;
  messagesUpdatedCount: number;
}

export function buildContactHandleDedupKey(
  handleType: string,
  handle: string,
): string {
  const normalized = normalizeHandleValue(handleType, handle);
  return `${handleType}:${normalized || handle.trim()}`;
}

function areStringArraysEqual(
  left?: string[],
  right?: string[],
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function buildMergeMetadataChanges(
  args: ExecuteContactMergeArgs,
): {
  updates: Partial<Doc<"contacts">>;
  primaryFieldChanges: MergePrimaryFieldChanges;
} {
  const updates: Partial<Doc<"contacts">> = {};

  if (args.actor === "user") {
    const resolutions = args.fieldResolutions;
    if (resolutions?.displayName === "secondary") {
      updates.displayName = args.secondaryContact.displayName;
    }
    if (resolutions?.company === "secondary") {
      updates.company = args.secondaryContact.company;
    } else if (
      !resolutions?.company &&
      !args.primaryContact.company &&
      args.secondaryContact.company
    ) {
      updates.company = args.secondaryContact.company;
    }
    if (resolutions?.notes === "secondary") {
      updates.notes = args.secondaryContact.notes;
    } else if (resolutions?.notes === "merge" && args.secondaryContact.notes) {
      updates.notes = args.primaryContact.notes
        ? `${args.primaryContact.notes}\n\n${args.secondaryContact.notes}`
        : args.secondaryContact.notes;
    } else if (
      !resolutions?.notes &&
      !args.primaryContact.notes &&
      args.secondaryContact.notes
    ) {
      updates.notes = args.secondaryContact.notes;
    }
    if (args.secondaryContact.tags?.length) {
      updates.tags = [
        ...new Set([
          ...(args.primaryContact.tags ?? []),
          ...args.secondaryContact.tags,
        ]),
      ];
    }
  } else {
    if (!args.primaryContact.company && args.secondaryContact.company) {
      updates.company = args.secondaryContact.company;
    }
    if (!args.primaryContact.notes && args.secondaryContact.notes) {
      updates.notes = args.secondaryContact.notes;
    }
  }

  if (
    args.primaryContact.importance === undefined &&
    args.secondaryContact.importance !== undefined
  ) {
    updates.importance = args.secondaryContact.importance;
  }

  const primaryFieldChanges: MergePrimaryFieldChanges = {};
  if (
    updates.displayName !== undefined &&
    updates.displayName !== args.primaryContact.displayName
  ) {
    primaryFieldChanges.displayName = {
      before: args.primaryContact.displayName,
      after: updates.displayName,
    };
  }
  if (
    updates.company !== undefined &&
    updates.company !== args.primaryContact.company
  ) {
    primaryFieldChanges.company = {
      before: args.primaryContact.company,
      after: updates.company,
    };
  }
  if (updates.notes !== undefined && updates.notes !== args.primaryContact.notes) {
    primaryFieldChanges.notes = {
      before: args.primaryContact.notes,
      after: updates.notes,
    };
  }
  if (
    updates.importance !== undefined &&
    updates.importance !== args.primaryContact.importance
  ) {
    primaryFieldChanges.importance = {
      before: args.primaryContact.importance,
      after: updates.importance,
    };
  }
  if (
    updates.tags !== undefined &&
    !areStringArraysEqual(updates.tags, args.primaryContact.tags)
  ) {
    primaryFieldChanges.tags = {
      before: args.primaryContact.tags,
      after: updates.tags,
    };
  }

  return { updates, primaryFieldChanges };
}

export async function executeContactMerge(
  ctx: MutationCtx,
  args: ExecuteContactMergeArgs,
): Promise<ExecuteContactMergeResult> {
  const now = Date.now();

  const [primaryHandles, secondaryHandles] = await Promise.all([
    ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) => q.eq("contactId", args.primaryContactId))
      .collect(),
    ctx.db
      .query("contactHandles")
      .withIndex("by_contact", (q) => q.eq("contactId", args.secondaryContactId))
      .collect(),
  ]);

  const primaryHandleByKey = new Map(
    primaryHandles.map((h) => [
      buildContactHandleDedupKey(h.handleType, h.handle),
      h._id,
    ]),
  );
  const explicitAuditMessageIds = new Set<Id<"messages">>();
  const dedupedHandlesForAudit: MergeDedupedHandleSnapshot[] = [];
  let handlesMovedCount = 0;
  for (const handle of secondaryHandles) {
    const key = buildContactHandleDedupKey(handle.handleType, handle.handle);
    const existingPrimaryHandleId = primaryHandleByKey.get(key);
    if (existingPrimaryHandleId) {
      dedupedHandlesForAudit.push({
        handleId: handle._id,
        handleType: handle.handleType,
        handle: handle.handle,
        platform: handle.platform,
        mergedIntoHandleId: existingPrimaryHandleId,
      });
      const messagesWithDuplicateHandle = await ctx.db
        .query("messages")
        .withIndex("by_sender_handle", (q) =>
          q.eq("senderHandleId", handle._id),
        )
        .collect();
      for (const msg of messagesWithDuplicateHandle) {
        explicitAuditMessageIds.add(msg._id);
        await ctx.db.patch(msg._id, { senderHandleId: existingPrimaryHandleId });
      }
      await ctx.db.delete(handle._id);
    } else {
      await ctx.db.patch(handle._id, { contactId: args.primaryContactId });
      primaryHandleByKey.set(key, handle._id);
      handlesMovedCount++;
    }
  }

  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .collect();

  const conversationSnapshots: MergeConversationSnapshot[] = [];
  for (const conv of conversations) {
    if (!conv.participantContactIds.includes(args.secondaryContactId)) continue;
    const hadPrimaryBeforeMerge = conv.participantContactIds.includes(
      args.primaryContactId,
    );
    conversationSnapshots.push({
      conversationId: conv._id,
      hadPrimaryBeforeMerge,
    });

    const withoutSecondary = conv.participantContactIds.filter(
      (id) => id !== args.secondaryContactId,
    );
    await ctx.db.patch(conv._id, {
      participantContactIds: hadPrimaryBeforeMerge
        ? withoutSecondary
        : [...withoutSecondary, args.primaryContactId],
    });
  }

  const messages = await ctx.db
    .query("messages")
    .withIndex("by_sender_contact", (q) =>
      q.eq("senderContactId", args.secondaryContactId),
    )
    .collect();
  for (const msg of messages) {
    if (msg.senderHandleId === undefined) {
      explicitAuditMessageIds.add(msg._id);
    }
    await ctx.db.patch(msg._id, { senderContactId: args.primaryContactId });
  }
  const explicitMessageIds = [...explicitAuditMessageIds];
  const messageIdsForAudit =
    explicitMessageIds.length > 0 &&
    explicitMessageIds.length <= MAX_MERGE_AUDIT_MESSAGE_IDS
      ? explicitMessageIds
      : undefined;

  await resolveMergeArtifactsForContactMerge(
    ctx,
    args.userId,
    args.primaryContactId,
    args.secondaryContactId,
    now,
  );

  const { updates, primaryFieldChanges } = buildMergeMetadataChanges(args);
  const primaryAvatarOptions = getContactAvatarOptions(args.primaryContact);
  const secondaryAvatarOptions = getContactAvatarOptions(args.secondaryContact);
  let mergedAvatarOptions = primaryAvatarOptions;
  for (const option of secondaryAvatarOptions) {
    mergedAvatarOptions = upsertContactAvatarOption(mergedAvatarOptions, option);
  }
  if (!areContactAvatarOptionsEqual(primaryAvatarOptions, mergedAvatarOptions)) {
    Object.assign(updates, buildPrimaryAvatarFields(mergedAvatarOptions), {
      avatarOptions: mergedAvatarOptions,
    });
  }

  if (Object.keys(updates).length > 0) {
    await ctx.db.patch(args.primaryContactId, updates);
  }

  const mergeAuditId = await ctx.db.insert("contactAuditLog", {
    userId: args.userId,
    contactId: args.primaryContactId,
    action: "merge",
    actor: args.actor,
    details: {
      secondaryContact: {
        _id: args.secondaryContact._id,
        displayName: args.secondaryContact.displayName,
        company: args.secondaryContact.company,
        notes: args.secondaryContact.notes,
        importance: args.secondaryContact.importance,
        tags: args.secondaryContact.tags,
      },
      handleIds: secondaryHandles.map((h) => h._id),
      dedupedHandles:
        dedupedHandlesForAudit.length > 0 ? dedupedHandlesForAudit : undefined,
      messageIds: messageIdsForAudit,
      conversationSnapshots,
      source: args.source,
      reasoning: args.reasoning,
      fieldResolutions:
        args.fieldResolutions && Object.keys(args.fieldResolutions).length > 0
          ? args.fieldResolutions
          : undefined,
      primaryFieldChanges:
        Object.keys(primaryFieldChanges).length > 0
          ? primaryFieldChanges
          : undefined,
    },
    timestamp: now,
  });

  if (!messageIdsForAudit && explicitMessageIds.length > 0) {
    await Promise.all(
      explicitMessageIds.map((messageId) =>
        ctx.db.insert("contactMergeMessageRefs", {
          userId: args.userId,
          mergeAuditId,
          messageId,
        }),
      ),
    );
  }

  await ctx.db.delete(args.secondaryContactId);

  return {
    handlesMovedCount,
    conversationsUpdatedCount: conversationSnapshots.length,
    messagesUpdatedCount: messages.length,
  };
}
