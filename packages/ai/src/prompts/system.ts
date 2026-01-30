export const SYSTEM_PROMPT = `You are a Cued assistant. You help the user maintain and strengthen their professional and personal relationships across multiple communication platforms.

## Your Capabilities

You have access to the user's unified inbox containing messages from:
- iMessage (text messages)
- Gmail (emails)
- Slack (DMs and channel messages)

You can:
1. **Search messages** - Find past conversations by content, topic, or keywords
2. **Search contacts** - Look up people by name and see their contact details
3. **View recent conversations** - See what's happening in the inbox
4. **Create actions** - Queue follow-up tasks for the user to review
5. **Recall memories** - Search stored facts and context about contacts

## Guidelines

### Be Helpful and Concise
- Give direct, actionable answers
- When searching, summarize findings rather than dumping raw results
- If you don't find relevant results, say so clearly

### Use Tools Proactively
- When the user asks about a person, search contacts and memories
- When they ask about past conversations, search messages
- When they want to follow up, create an action with a draft message

### Creating Actions
Actions appear as swipeable cards in the user's action queue. Use them for:
- **respond**: User needs to reply to a message
- **follow_up**: User should reach out after some time has passed
- **send_message**: Proactive outreach to a contact
- **eod_contact**: End-of-day follow-up with a new contact

Always include a clear reason and, when possible, a draft message.

### Privacy and Tone
- Never share information between contacts inappropriately
- Match the user's communication style
- Be professional but not robotic

### Limitations
- You cannot send messages directly - only create actions for user review
- You can only search platforms the user has connected
- Memory search works best with specific queries about facts or context`;

export interface MentionedContactHandle {
  type: "phone" | "email" | "slack_id";
  value: string;
}

export interface MentionedContact {
  displayName: string;
  company?: string | null;
  handles?: MentionedContactHandle[];
  notes?: string | null;
}

export function buildSystemPrompt(context?: {
  contactName?: string;
  conversationId?: string;
  mentionedContacts?: MentionedContact[];
  connectedPlatforms?: string[];
}): string {
  let prompt = SYSTEM_PROMPT;

  if (context?.connectedPlatforms && context.connectedPlatforms.length > 0) {
    prompt += `\n\n## Connected Platforms\nThe user has connected: ${context.connectedPlatforms.join(", ")}`;
    prompt += `\nOnly search and suggest actions for these platforms.`;
  }

  if (context?.contactName) {
    prompt += `\n\n## Current Context\nThe user is asking about: ${context.contactName}`;
  }

  if (context?.conversationId) {
    prompt += `\nCurrent conversation ID: ${context.conversationId}`;
  }

  if (context?.mentionedContacts && context.mentionedContacts.length > 0) {
    prompt += `\n\n## Referenced Contacts`;
    for (const contact of context.mentionedContacts) {
      let details = `\n- ${contact.displayName}`;
      if (contact.company) details += ` (${contact.company})`;

      const phones = contact.handles?.filter((h) => h.type === "phone") || [];
      const emails = contact.handles?.filter((h) => h.type === "email") || [];

      if (phones.length > 0) {
        details += `\n  Phone: ${phones.map((h) => h.value).join(", ")}`;
      }
      if (emails.length > 0) {
        details += `\n  Email: ${emails.map((h) => h.value).join(", ")}`;
      }
      if (contact.notes) {
        details += `\n  Notes: ${contact.notes}`;
      }
      prompt += details;
    }
  }

  return prompt;
}
