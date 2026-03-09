import { describe, expect, it } from "vitest";
import { buildSlackSyncBundle } from "../workers/slack-worker-lib.js";
describe("slack worker lib", () => {
    it("builds a raw event bundle from Slack users, conversations, messages, and reactions", async () => {
        const bundle = await buildSlackSyncBundle({
            accountKey: "default",
            lastSyncAt: 1_700_000_000_000,
            client: {
                async testAuth() {
                    return { ok: true, team_id: "T123", user_id: "U_SELF", team: "Acme", user: "Ava" };
                },
                async listUsers() {
                    return {
                        users: [
                            {
                                id: "U_SELF",
                                team_id: "T123",
                                name: "ava",
                                real_name: "Ava Chen",
                                profile: { email: "ava@example.com", image_192: "https://img/ava.png" },
                            },
                            {
                                id: "U_BEN",
                                team_id: "T123",
                                name: "ben",
                                real_name: "Ben Ortiz",
                                profile: { email: "ben@example.com" },
                            },
                        ],
                        nextCursor: undefined,
                    };
                },
                async listConversations() {
                    return {
                        conversations: [
                            {
                                id: "D123",
                                is_im: true,
                                user: "U_BEN",
                                latest: undefined,
                            },
                        ],
                        nextCursor: undefined,
                    };
                },
                async getConversationMembers() {
                    return { members: [], nextCursor: undefined };
                },
                async getHistory() {
                    return {
                        messages: [
                            {
                                type: "message",
                                user: "U_BEN",
                                text: "Hi from Slack",
                                ts: "1710000000.000100",
                                reactions: [
                                    { name: "thumbsup", count: 1, users: ["U_SELF"] },
                                ],
                                files: [
                                    { id: "F1", name: "resume.pdf", url_private_download: "https://files/resume.pdf" },
                                ],
                            },
                        ],
                        hasMore: false,
                        nextCursor: undefined,
                    };
                },
            },
        });
        expect(bundle.sourceAccounts).toEqual([
            { platform: "slack", accountKey: "default", displayName: "Acme" },
        ]);
        expect(bundle.syncMode).toBe("incremental");
        expect(bundle.sourceCursor).toEqual(expect.objectContaining({ teamId: "T123", selfUserId: "U_SELF" }));
        expect(bundle.rawEvents.some((event) => event.entityKind === "contact")).toBe(true);
        expect(bundle.rawEvents.some((event) => event.entityKind === "conversation")).toBe(true);
        expect(bundle.rawEvents.some((event) => event.entityKind === "message")).toBe(true);
        expect(bundle.rawEvents.some((event) => event.entityKind === "reaction")).toBe(true);
        const messageEvent = bundle.rawEvents.find((event) => event.entityKind === "message");
        expect(messageEvent?.payload).toEqual(expect.objectContaining({
            sourceConversationKey: "slack:T123:D123",
            senderSourceKey: "slack:T123:U_BEN",
            hasAttachments: true,
        }));
    });
});
//# sourceMappingURL=slack-worker-lib.test.js.map