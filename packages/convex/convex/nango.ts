"use node";

import { v } from "convex/values";
import { Nango } from "@nangohq/node";
import { internalAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { requireEnv } from "@cued/env/convex";

// ============================================================================
// Nango SDK Instance
// ============================================================================

function getNango(): Nango {
  return new Nango({ secretKey: requireEnv("NANGO_SECRET_KEY") });
}

// ============================================================================
// Webhook Signature Verification
// ============================================================================

/**
 * Verify Nango webhook signature.
 * Uses Nango SDK's verifyIncomingWebhookRequest method.
 */
export const verifyWebhookSignature = internalAction({
  args: {
    signature: v.string(),
    rawBody: v.string(),
  },
  handler: async (_ctx, args) => {
    const nango = getNango();

    // Parse body for verification
    let body: unknown;
    try {
      body = JSON.parse(args.rawBody);
    } catch {
      console.error("Failed to parse webhook body for signature verification");
      return false;
    }

    try {
      return nango.verifyWebhookSignature(args.signature, body);
    } catch (e) {
      console.error("Webhook signature verification error:", e);
      return false;
    }
  },
});

// ============================================================================
// Sync Webhook Handlers
// ============================================================================

interface GmailEmail {
  id: string;
  sender: string;
  recipients?: string;
  date: string;
  subject: string;
  body?: string;
  attachments: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
  }>;
  threadId: string;
  labelIds?: string[];
}

interface NangoRecord extends GmailEmail {
  _nango_metadata?: {
    cursor?: string;
    first_seen_at?: string;
    last_modified_at?: string;
    last_action?: string;
    deleted_at?: string | null;
  };
}

interface GoogleContact {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  company?: string;
  title?: string;
  isDeleted: boolean;
}

// TypeScript types for sync results (breaks circular inference)
interface GmailSyncResult {
  messagesCount: number;
  conversationsCount: number;
  skippedFiltered: number;
  errors: string[];
}

interface ContactsSyncResult {
  contactsCount: number;
  updatedCount: number;
  deletedCount: number;
  handlesCount: number;
  errors: string[];
}

// Return type validator for sync results
const syncResultValidator = v.object({
  messagesCount: v.optional(v.number()),
  conversationsCount: v.optional(v.number()),
  skippedFiltered: v.optional(v.number()),
  contactsCount: v.optional(v.number()),
  updatedCount: v.optional(v.number()),
  deletedCount: v.optional(v.number()),
  handlesCount: v.optional(v.number()),
  errors: v.optional(v.array(v.string())),
});

/**
 * Pull Gmail records from Nango and sync to Convex.
 */
export const pullGmailRecords = internalAction({
  args: {
    connectionId: v.string(),
    workosUserId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.optional(v.string()),
    count: v.optional(v.number()),
    result: v.optional(syncResultValidator),
    recordsProcessed: v.optional(v.number()),
    accountEmail: v.optional(v.string()),
    syncMode: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    console.log("[Gmail Pull] Starting", { connectionId: args.connectionId, workosUserId: args.workosUserId });
    const nango = getNango();

    // Get connection to extract account email for multi-account support
    const connection = await nango.getConnection("google", args.connectionId);
    const rawEmail = (connection?.credentials as { raw?: { email?: unknown } })?.raw?.email;
    const accountEmail = typeof rawEmail === "string" ? rawEmail : undefined;
    console.log("[Gmail Pull] Account email:", accountEmail ?? "(not found)");

    if (!accountEmail) {
      console.warn("[Gmail Pull] Connection missing account email, sync will not track multi-account state");
    }

    // Get stored cursor for incremental sync
    let storedCursor: string | undefined;
    if (accountEmail) {
      const cursorResult = await ctx.runQuery(api.sync.getGmailCursor, {
        accountEmail,
        workosUserId: args.workosUserId,
      });
      storedCursor = cursorResult?.cursorData?.nangoCursor as string | undefined;
      console.log("[Gmail Pull] Stored cursor:", storedCursor ?? "(none - full sync)");
    }

    // Fetch records from Nango
    console.log("[Gmail Pull] Fetching records from Nango...");
    const { records } = await nango.listRecords<NangoRecord>({
      providerConfigKey: "google",
      connectionId: args.connectionId,
      model: "GmailEmail",
      ...(storedCursor && { cursor: storedCursor }),
    });

    console.log("[Gmail Pull] Raw records count:", records?.length ?? 0);

    if (!records || records.length === 0) {
      console.log("[Gmail Pull] No new records");
      return { success: true, message: "No new records", count: 0 };
    }

    // Log first record for debugging
    if (records.length > 0) {
      const first = records[0];
      console.log("[Gmail Pull] First record sample:", {
        id: first.id,
        threadId: first.threadId,
        sender: first.sender,
        recipients: first.recipients,
        subject: first.subject?.substring(0, 50),
        date: first.date,
        hasBody: !!first.body,
        bodyLength: first.body?.length ?? 0,
        labelIds: first.labelIds,
        metadata: first._nango_metadata,
      });
    }

    // Extract cursor from last record
    const lastRecord = records[records.length - 1];
    const nangoCursor = lastRecord._nango_metadata?.cursor;

    if (!nangoCursor && records.length > 0) {
      console.warn("[Gmail Pull] Last record missing cursor metadata");
    }

    // Strip Nango metadata
    const cleanedRecords = records.map((record: NangoRecord) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _nango_metadata, ...email } = record;
      return email as GmailEmail;
    });

    const syncMode = storedCursor ? "incremental" : "full";
    console.log("[Gmail Pull] Syncing", cleanedRecords.length, "records in", syncMode, "mode");

    // Sync to Convex (explicit type to break circular inference)
    const result: GmailSyncResult = await ctx.runMutation(api.sync.syncGmailMessages, {
      workosUserId: args.workosUserId,
      emails: cleanedRecords,
      accountEmail,
      nangoCursor,
      syncMode,
    });

    console.log("[Gmail Pull] Sync complete:", {
      accountEmail,
      syncMode,
      recordsFromNango: records.length,
      messagesCreated: result.messagesCount,
      conversationsCreated: result.conversationsCount,
      skippedFiltered: result.skippedFiltered,
      errors: result.errors?.length ?? 0,
    });

    return {
      success: true,
      result,
      recordsProcessed: records.length,
      accountEmail,
      syncMode,
    };
  },
});

/**
 * Pull Google Contacts from Nango and sync to Convex.
 */
export const pullGoogleContacts = internalAction({
  args: {
    connectionId: v.string(),
    workosUserId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.optional(v.string()),
    count: v.optional(v.number()),
    result: v.optional(syncResultValidator),
    recordsProcessed: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    console.log("[Contacts Pull] Starting", { connectionId: args.connectionId, workosUserId: args.workosUserId });
    const nango = getNango();

    // Fetch records from Nango
    console.log("[Contacts Pull] Fetching records from Nango...");
    const { records } = await nango.listRecords<GoogleContact>({
      providerConfigKey: "google",
      connectionId: args.connectionId,
      model: "GoogleContact",
    });

    console.log("[Contacts Pull] Raw records count:", records?.length ?? 0);

    if (!records || records.length === 0) {
      console.log("[Contacts Pull] No records");
      return { success: true, message: "No records", count: 0 };
    }

    // Log first few records for debugging
    console.log("[Contacts Pull] First 3 records sample:");
    for (let i = 0; i < Math.min(3, records.length); i++) {
      const r = records[i];
      console.log(`[Contacts Pull] Record ${i + 1}:`, {
        id: r.id,
        name: r.name,
        emails: r.emails,
        phones: r.phones,
        company: r.company,
        title: r.title,
        isDeleted: r.isDeleted,
      });
    }

    // Strip Nango metadata
    const cleanedRecords = records.map((record) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      const { _nango_metadata: _, nango_metadata: __, ...contact } = record as any;
      return contact as GoogleContact;
    });

    console.log("[Contacts Pull] Syncing", cleanedRecords.length, "contacts to Convex...");

    // Sync to Convex (explicit type to break circular inference)
    const result: ContactsSyncResult = await ctx.runMutation(api.sync.syncGoogleContacts, {
      workosUserId: args.workosUserId,
      contacts: cleanedRecords,
    });

    console.log("[Contacts Pull] Sync complete:", {
      recordsFromNango: records.length,
      contactsCreated: result.contactsCount,
      contactsUpdated: result.updatedCount,
      contactsDeleted: result.deletedCount,
      handlesCreated: result.handlesCount,
      errors: result.errors?.length ?? 0,
    });

    return {
      success: true,
      result,
      recordsProcessed: records.length,
    };
  },
});

// ============================================================================
// Retry Logic
// ============================================================================

/**
 * Retry a failed sync handler.
 */
export const retrySyncHandler = internalAction({
  args: {
    workosUserId: v.string(),
    connectionId: v.string(),
    handler: v.string(),
    attemptNumber: v.number(),
  },
  handler: async (ctx, args) => {
    console.log(`[Nango] Retry attempt ${args.attemptNumber} for ${args.handler}`);

    try {
      if (args.handler === "gmail") {
        await ctx.runAction(internal.nango.pullGmailRecords, {
          connectionId: args.connectionId,
          workosUserId: args.workosUserId,
        });
      } else if (args.handler === "google-contacts") {
        await ctx.runAction(internal.nango.pullGoogleContacts, {
          connectionId: args.connectionId,
          workosUserId: args.workosUserId,
        });
      }
      console.log(`[Nango] Retry successful for ${args.handler}`);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Unknown error";
      console.error(`[Nango] Retry failed for ${args.handler}:`, errorMsg);

      // Log failure for next retry
      await ctx.runMutation(internal.nangoMutations.logSyncFailure, {
        workosUserId: args.workosUserId,
        connectionId: args.connectionId,
        handler: args.handler,
        error: errorMsg,
        attemptNumber: args.attemptNumber,
      });
    }
  },
});

