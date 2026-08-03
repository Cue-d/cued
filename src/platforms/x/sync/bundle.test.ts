import { describe, expect, it } from "vitest";
import { type BirdclawSnapshot, buildXSyncBundle } from "./bundle.js";

const snapshot: BirdclawSnapshot = {
  generation: "archive-v1",
  account: { id: "10", name: "Sam", handle: "sam", external_user_id: "10" },
  profiles: [
    {
      id: "profile_user_20",
      handle: "ava",
      display_name: "Ava",
      bio: "Robotics",
      followers_count: 100,
      following_count: 80,
      avatar_url: "https://pbs.twimg.com/ava.jpg",
      location: "New York",
      url: "https://ava.example",
      verified_type: "blue",
    },
  ],
  conversations: [
    {
      id: "10-20",
      participant_ids: ["20"],
      title: "Ava",
      last_message_at: "2026-08-03T12:00:00.000Z",
      is_group: false,
    },
  ],
  messages: [
    {
      id: "message-1",
      conversation_id: "10-20",
      sender_profile_id: "profile_user_20",
      text: "Hello from Birdclaw",
      created_at: "2026-08-03T12:00:00.000Z",
      direction: "inbound",
    },
  ],
  followEdges: [
    {
      direction: "followers",
      profile_id: "profile_user_20",
      external_user_id: "20",
      source: "archive",
      first_seen_at: "2026-01-01T00:00:00.000Z",
      last_seen_at: "2026-08-01T00:00:00.000Z",
    },
    {
      direction: "following",
      profile_id: "profile_user_20",
      external_user_id: "20",
      source: "archive",
      first_seen_at: "2026-01-01T00:00:00.000Z",
      last_seen_at: "2026-08-01T00:00:00.000Z",
    },
  ],
  hasMore: false,
  nextMessageOffset: 1,
  totalMessageCount: 1,
  totalRelationshipCount: 2,
};

describe("Birdclaw X sync bundle", () => {
  it("normalizes DMs, deterministic X identities, and mutual graph metadata", async () => {
    const bundle = await buildXSyncBundle({ accountKey: "default" }, { snapshot });

    expect(bundle.sourceAccounts).toEqual([
      { platform: "x", accountKey: "10", displayName: "@sam" },
    ]);
    expect(bundle.rawEvents.map((event) => `${event.entityKind}.${event.eventKind}`)).toEqual([
      "contact.observed",
      "conversation.observed",
      "message.created",
      "contact.snapshot_completed",
    ]);
    expect(bundle.rawEvents[0]?.payload).toMatchObject({
      sourceEntityKey: "x:user:20",
      handles: expect.arrayContaining([
        { type: "x_user_id", value: "20", deterministic: true },
        { type: "x_handle", value: "ava", deterministic: true },
      ]),
      sourceMetadata: {
        archiveGeneration: "archive-v1",
        followsYou: true,
        youFollow: true,
        mutual: true,
        followersCount: 100,
      },
    });
    expect(bundle.rawEvents.find((event) => event.entityKind === "message")?.payload).toMatchObject(
      {
        content: "Hello from Birdclaw",
        senderSourceKey: "x:user:20",
        isFromMe: false,
      },
    );
    expect(bundle.proofs?.[0]?.coverage).toMatchObject({
      source: "x_archive",
      generation: "archive-v1",
      relationshipEdges: 2,
    });
    expect(bundle.proofs?.[0]?.stats).toMatchObject({
      messageCount: 1,
      relationshipEdgeCount: 2,
      pageRawEventCount: 4,
    });
  });

  it("continues from the helper cursor when another DM page remains", async () => {
    const bundle = await buildXSyncBundle(
      {},
      {
        snapshot: { ...snapshot, hasMore: true, nextPhase: "relationships", nextEdgeOffset: 10 },
        sourceCursor: { messageOffset: 0 },
      },
    );
    expect(bundle.hasMore).toBe(true);
    expect(bundle.sourceCursor).toEqual({
      generation: "archive-v1",
      phase: "relationships",
      messageOffset: 1,
      edgeOffset: 10,
    });
    expect(bundle.proofs?.[0]?.status).toBe("running");
  });

  it("keeps outbound and group participants on real X user identities", async () => {
    const bundle = await buildXSyncBundle(
      {},
      {
        snapshot: {
          ...snapshot,
          profiles: [
            ...snapshot.profiles,
            { ...snapshot.profiles[0]!, id: "profile_user_30", handle: "lee", display_name: "Lee" },
          ],
          conversations: [
            {
              id: "group-1",
              participant_ids: ["20", "30"],
              title: "Builders",
              last_message_at: "2026-08-03T13:00:00.000Z",
              is_group: true,
            },
          ],
          messages: [
            {
              id: "message-2",
              conversation_id: "group-1",
              sender_profile_id: "profile_user_10",
              text: "Sent by me",
              created_at: "2026-08-03T13:00:00.000Z",
              direction: "outbound",
            },
          ],
          followEdges: [],
        },
      },
    );
    const conversation = bundle.rawEvents.find((event) => event.entityKind === "conversation");
    expect(conversation?.payload).toMatchObject({
      conversationType: "group",
      participantsAreSnapshot: true,
      participants: [
        { sourceEntityKey: "x:user:10", isSelf: true },
        { sourceEntityKey: "x:user:20" },
        { sourceEntityKey: "x:user:30" },
      ],
    });
    expect(bundle.rawEvents.find((event) => event.entityKind === "message")?.payload).toMatchObject(
      {
        senderSourceKey: "x:user:10",
        isFromMe: true,
      },
    );
  });
});
