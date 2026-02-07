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
        id: "m0",
        content: "Really enjoyed your talk on product-led growth btw",
        isFromMe: false,
        senderName: "Sarah Chen",
      },
      {
        id: "m1",
        content:
          "Hey! It was great meeting you at the conference yesterday. Would love to grab coffee sometime this week.",
        isFromMe: false,
        senderName: "Sarah Chen",
      },
      {
        id: "m2",
        content:
          "Also, I mentioned that intro to our head of product — still happy to make that happen if you're interested.",
        isFromMe: false,
        senderName: "Sarah Chen",
      },
      {
        id: "m3",
        content: "Sounds great! How about Thursday morning?",
        isFromMe: true,
      },
    ],
    draftText:
      "That would be amazing — Thursday at 10am works for me! And yes, I'd love the intro to your head of product. Really appreciate it!",
    reason: "respond",
  },
  {
    type: "message",
    id: "msg-gmail",
    platform: "gmail",
    personName: "James Park",
    messages: [
      {
        id: "m3b",
        content: "Great chatting at the founders dinner last week.",
        isFromMe: true,
      },
      {
        id: "m4",
        content:
          "Likewise! I've put together the partnership proposal we discussed. Let me know when you have a chance to review.",
        isFromMe: false,
        senderName: "James Park",
      },
      {
        id: "m5",
        content:
          "Thanks James! I'll take a look this week and get back to you.",
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
      "Hey James — I've reviewed the proposal and it looks solid. A few thoughts I'd love to discuss. Free for a quick call tomorrow afternoon?",
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
          "Hi! I saw your post about hiring for a senior eng role. I have someone who'd be a perfect fit — she led infra at Datadog for 3 years.",
        isFromMe: false,
        senderName: "Priya Sharma",
      },
      {
        id: "m8",
        content:
          "Oh amazing, we're definitely still looking. Can you tell me more about her background?",
        isFromMe: true,
      },
      {
        id: "m9",
        content:
          "For sure — she specializes in distributed systems and has scaled teams from 5 to 30. Want me to intro you two?",
        isFromMe: false,
        senderName: "Priya Sharma",
      },
    ],
    draftText:
      "That sounds like a great fit! Yes please, would love an intro. Happy to chat with her this week if she's available.",
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
    notes:
      "Lead designer on FigJam. Interested in collaboration on our design system.",
  },
  {
    type: "message",
    id: "msg-slack",
    platform: "slack",
    personName: "Dana Kim",
    messages: [
      {
        id: "m10",
        content:
          "Hey — quick q. Are you still planning to attend the YC demo day next Tuesday?",
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
          "Yeah! Want to grab dinner after? I know a few other founders going and we could do a group thing.",
        isFromMe: false,
        senderName: "Dana Kim",
      },
    ],
    draftText:
      "That sounds awesome! Count me in. Want me to reach out to a couple people on my end too?",
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
        content:
          "Thanks Lena! We should catch up soon — it's been way too long.",
        isFromMe: true,
      },
      {
        id: "m15",
        content:
          "Yes!! Let's do brunch this weekend? I know a great new spot in Hayes Valley.",
        isFromMe: false,
        senderName: "Lena Torres",
      },
    ],
    draftText:
      "That sounds perfect! Saturday or Sunday works for me. Just send me the address!",
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
          "Following up from our meeting last week. The team was really impressed with your product demo.",
        isFromMe: false,
        senderName: "Ryan Kessler",
      },
      {
        id: "m17",
        content:
          "That's great to hear! Happy to answer any follow-up questions.",
        isFromMe: true,
      },
      {
        id: "m18",
        content:
          "We'd love to schedule a deeper dive with our technical team. Would next Wednesday work?",
        isFromMe: false,
        senderName: "Ryan Kessler",
      },
    ],
    draftText:
      "Wednesday works great! I'll prepare a more detailed technical walkthrough. Should I include our API documentation ahead of time?",
    reason: "follow_up",
  },
  {
    type: "contact",
    id: "new-contact-2",
    platform: "linkedin",
    personName: "Tomoko Sato",
    company: "Notion",
    tags: ["product", "SF meetup"],
    notes:
      "PM on Notion's integrations team. Interested in potential API partnership.",
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
