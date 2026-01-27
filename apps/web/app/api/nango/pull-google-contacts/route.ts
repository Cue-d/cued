import { NextRequest, NextResponse } from "next/server";
import { Nango } from "@nangohq/node";
import { api } from "@prm/convex";
import { env } from "@prm/env/server";
import { extractErrorMessage, getConvexClient } from "@/lib/api-utils";

const nango = new Nango({ secretKey: env.NANGO_SECRET_KEY });

interface GoogleContact {
  id: string; // resourceName from Google People API
  name: string;
  emails: string[];
  phones: string[];
  company?: string;
  title?: string;
  isDeleted: boolean;
}

/**
 * POST /api/nango/pull-google-contacts
 * Pull Google Contacts from Nango and sync to Convex.
 *
 * Called by:
 * 1. Nango sync webhook when sync completes
 * 2. Manual trigger for testing
 *
 * Body: { connectionId: string, workosUserId: string }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { connectionId, workosUserId } = body;

    if (!connectionId || !workosUserId) {
      return NextResponse.json(
        { error: "Missing connectionId or workosUserId" },
        { status: 400 }
      );
    }

    // Fetch records from Nango (model name must match sync definition)
    const { records } = await nango.listRecords<GoogleContact>({
      providerConfigKey: "google",
      connectionId,
      model: "GoogleContact",
    });

    if (!records || records.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No new records to sync",
        count: 0,
      });
    }

    // Strip Nango metadata before sending to Convex
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanedRecords = records.map((record: any) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { nango_metadata: _nango_metadata, ...contact } = record;
      return contact as GoogleContact;
    });

    // Sync to Convex
    const convex = getConvexClient();
    const result = await convex.mutation(api.sync.syncGoogleContacts, {
      workosUserId,
      contacts: cleanedRecords,
    });

    console.log("Google Contacts sync complete:", {
      contacts: result.contactsCount,
      updated: result.updatedCount,
      deleted: result.deletedCount,
      handles: result.handlesCount,
    });

    return NextResponse.json({
      success: true,
      result,
      recordsProcessed: records.length,
    });
  } catch (error) {
    const message = extractErrorMessage(error, "Pull failed");
    console.error("Google Contacts pull error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
