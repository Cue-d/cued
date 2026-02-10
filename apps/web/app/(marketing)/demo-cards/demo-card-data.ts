// Minimal local types for demo data — no @cued/shared imports needed
export type DemoPlatform = "imessage" | "gmail" | "slack" | "linkedin";

export interface DemoMessage {
  id: string;
  content: string;
  isFromMe: boolean;
  senderName?: string;
}

export interface DemoHandle {
  type: "phone" | "email" | "slack_id" | "linkedin_handle";
  value: string;
  platform: DemoPlatform;
}

export interface DemoContact {
  name: string;
  company?: string;
  handles: DemoHandle[];
}

// ── Card definitions ──

export interface MessageCardData {
  type: "message";
  id: string;
  platform: DemoPlatform;
  personName: string;
  messages: DemoMessage[];
  draftText: string;
  reason?: string;
}

export interface ContactCardData {
  type: "contact";
  id: string;
  platform: DemoPlatform;
  personName: string;
  company: string;
  tags: string[];
  notes: string;
}

export interface ResolveCardData {
  type: "resolve";
  id: string;
  contact1: DemoContact;
  contact2: DemoContact;
  confidence: number;
  source:
    | "email_match"
    | "phone_match"
    | "exact_name_match"
    | "fuzzy_name_match";
  reasoning: string;
}

export type DemoCard = MessageCardData | ContactCardData | ResolveCardData;

// ── Swipe action config ──

export type SwipeAction = {
  label: string;
  color: string; // hex color for tint + progress ring
};

export type SwipeActions = {
  right: SwipeAction;
  left: SwipeAction;
  up?: SwipeAction;
};

export function getSwipeActions(card: DemoCard): SwipeActions {
  switch (card.type) {
    case "message":
      return {
        right: { label: "Send", color: "#1B5E3D" },
        left: { label: "Dismiss", color: "#6B7280" },
        up: { label: "Snooze", color: "#B45309" },
      };
    case "contact":
      return {
        right: { label: "Save", color: "#1B5E3D" },
        left: { label: "Skip", color: "#6B7280" },
      };
    case "resolve":
      return {
        right: { label: "Merge", color: "#2563EB" },
        left: { label: "Different", color: "#6B7280" },
      };
  }
}

// ── Demo data ──

export const DEMO_CARDS: DemoCard[] = [
  {
    type: "message",
    id: "msg-imessage",
    platform: "imessage",
    personName: "Sarah Chen",
    messages: [
      {
        id: "m1",
        content:
          "Great meeting you at the conference! Would love to grab coffee this week.",
        isFromMe: false,
        senderName: "Sarah Chen",
      },
      {
        id: "m2",
        content: "Sounds great! How about Thursday morning?",
        isFromMe: true,
      },
      {
        id: "m3",
        content:
          "Thursday works! I also mentioned that intro to our head of product — still happy to make that happen.",
        isFromMe: false,
        senderName: "Sarah Chen",
      },
    ],
    draftText:
      "Thursday at 10am works! And yes, I'd love the intro. Really appreciate it.",
    reason: "respond",
  },
  {
    type: "message",
    id: "msg-gmail",
    platform: "gmail",
    personName: "James Park",
    messages: [
      {
        id: "m4",
        content:
          "I've put together the partnership proposal we discussed. Let me know when you can review.",
        isFromMe: false,
        senderName: "James Park",
      },
      {
        id: "m5",
        content: "Thanks James! I'll take a look this week.",
        isFromMe: true,
      },
      {
        id: "m6",
        content: "No rush — happy to jump on a call whenever works.",
        isFromMe: false,
        senderName: "James Park",
      },
    ],
    draftText:
      "Reviewed the proposal — looks solid. Free for a quick call tomorrow afternoon?",
    reason: "follow_up",
  },
  {
    type: "message",
    id: "msg-linkedin",
    platform: "linkedin",
    personName: "Priya Sharma",
    messages: [
      {
        id: "m7",
        content:
          "I saw your post about hiring for a senior eng role. I have someone who'd be a perfect fit.",
        isFromMe: false,
        senderName: "Priya Sharma",
      },
      {
        id: "m8",
        content: "Oh amazing, we're definitely still looking. Tell me more?",
        isFromMe: true,
      },
      {
        id: "m9",
        content:
          "She led infra at Datadog for 3 years. Want me to intro you two?",
        isFromMe: false,
        senderName: "Priya Sharma",
      },
    ],
    draftText:
      "That sounds like a great fit! Yes please, would love an intro.",
    reason: "respond",
  },
  {
    type: "resolve",
    id: "resolve-contact",
    contact1: {
      name: "Mike Johnson",
      company: "Stripe",
      handles: [
        { type: "phone", value: "+1 (415) 555-0142", platform: "imessage" },
      ],
    },
    contact2: {
      name: "Michael Johnson",
      company: "Stripe",
      handles: [
        { type: "email", value: "mike.j@stripe.com", platform: "gmail" },
      ],
    },
    confidence: 0.92,
    source: "fuzzy_name_match",
    reasoning:
      "Same company, similar name pattern. Likely the same person across iMessage and Gmail.",
  },
  {
    type: "contact",
    id: "new-contact",
    platform: "slack",
    personName: "Alex Rivera",
    company: "Figma",
    tags: ["design", "met at offsite"],
    notes: "Lead designer on FigJam. Interested in design system collaboration.",
  },
  {
    type: "message",
    id: "msg-slack",
    platform: "slack",
    personName: "Dana Kim",
    messages: [
      {
        id: "m10",
        content: "Are you going to YC demo day next Tuesday?",
        isFromMe: false,
        senderName: "Dana Kim",
      },
      {
        id: "m11",
        content: "Yep! Are you going too?",
        isFromMe: true,
      },
      {
        id: "m12",
        content:
          "Yeah! Want to grab dinner after? I know a few other founders going.",
        isFromMe: false,
        senderName: "Dana Kim",
      },
    ],
    draftText:
      "Count me in! Want me to reach out to a couple people on my end too?",
    reason: "respond",
  },
  {
    type: "message",
    id: "msg-imessage-2",
    platform: "imessage",
    personName: "Lena Torres",
    messages: [
      {
        id: "m13",
        content: "Happy birthday!! Hope you have an amazing day",
        isFromMe: false,
        senderName: "Lena Torres",
      },
      {
        id: "m14",
        content: "Thanks Lena! We should catch up — it's been too long.",
        isFromMe: true,
      },
      {
        id: "m15",
        content:
          "Yes!! Brunch this weekend? Great new spot in Hayes Valley.",
        isFromMe: false,
        senderName: "Lena Torres",
      },
    ],
    draftText: "That sounds perfect! Saturday or Sunday works for me.",
    reason: "respond",
  },
  {
    type: "message",
    id: "msg-gmail-2",
    platform: "gmail",
    personName: "Ryan Kessler",
    messages: [
      {
        id: "m16",
        content:
          "Following up — the team was impressed with your product demo.",
        isFromMe: false,
        senderName: "Ryan Kessler",
      },
      {
        id: "m17",
        content: "Great to hear! Happy to answer any follow-up questions.",
        isFromMe: true,
      },
      {
        id: "m18",
        content:
          "We'd love a deeper dive with our technical team. Would next Wednesday work?",
        isFromMe: false,
        senderName: "Ryan Kessler",
      },
    ],
    draftText:
      "Wednesday works! I'll prepare a technical walkthrough. Should I send API docs ahead of time?",
    reason: "follow_up",
  },
  {
    type: "contact",
    id: "new-contact-2",
    platform: "linkedin",
    personName: "Tomoko Sato",
    company: "Notion",
    tags: ["product", "SF meetup"],
    notes: "PM on Notion integrations. Interested in API partnership.",
  },
  {
    type: "resolve",
    id: "resolve-contact-2",
    contact1: {
      name: "Emily Zhang",
      company: "Anthropic",
      handles: [
        { type: "email", value: "emily@anthropic.com", platform: "gmail" },
      ],
    },
    contact2: {
      name: "Emily Zhang",
      handles: [{ type: "slack_id", value: "U04EMILY", platform: "slack" }],
    },
    confidence: 0.97,
    source: "exact_name_match",
    reasoning:
      "Exact name match across Gmail and Slack. Very likely the same person.",
  },
];
