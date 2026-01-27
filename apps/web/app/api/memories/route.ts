import { NextRequest, NextResponse } from "next/server";
import { addContactMemories, type ConversationMessage } from "@prm/ai";
import { api, type Id } from "@prm/convex";
import {
  extractErrorMessage,
  getAuthenticatedConvexClient,
} from "@/lib/api-utils";

export async function POST(req: NextRequest) {
  const authResult = getAuthenticatedConvexClient(req);
  if ("error" in authResult) return authResult.error;
  const { convex } = authResult;

  // Get user identity
  let userId: string | null = null;
  try {
    const user = await convex.query(api.users.getCurrentUser);
    userId = user?.subject ?? null;
  } catch {
    return NextResponse.json({ error: "Failed to get user" }, { status: 401 });
  }

  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { conversationId, limit = 50 } = body;

  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }

  try {
    const messages = await convex.query(api.messages.getMessages, {
      conversationId: conversationId as Id<"conversations">,
      limit,
    });

    if (!messages?.messages?.length) {
      return NextResponse.json({
        success: true,
        memoriesAdded: 0,
        memoriesUpdated: 0,
        memoriesDeleted: 0,
        message: "No messages to process",
      });
    }

    const contactId =
      messages.messages.find((m) => !m.isFromMe)?.sender?._id ?? null;

    if (!contactId) {
      return NextResponse.json({
        success: true,
        memoriesAdded: 0,
        memoriesUpdated: 0,
        memoriesDeleted: 0,
        message: "No contact found for conversation (outgoing only)",
      });
    }

    const contact = await convex.query(api.search.searchContacts, {
      query: "",
      limit: 1,
    });
    const contactName = contact?.results?.find(
      (c) => c._id === contactId
    )?.displayName;

    const conversationMessages: ConversationMessage[] = messages.messages.map(
      (m) => ({
        role: m.isFromMe ? ("user" as const) : ("assistant" as const),
        content: m.content || "",
      })
    );

    const result = await addContactMemories(
      conversationMessages,
      userId,
      contactId,
      contactName
    );

    return NextResponse.json({
      success: true,
      ...result,
      messagesProcessed: conversationMessages.length,
      contactId,
      contactName,
    });
  } catch (error) {
    console.error("Error adding memories:", error);
    return NextResponse.json({ error: extractErrorMessage(error) }, { status: 500 });
  }
}
