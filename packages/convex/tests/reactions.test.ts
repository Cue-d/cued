import { describe, expect, it } from "vitest";
import { collectReactionContactIds, groupReactions } from "../convex/lib/reactions";

describe("reactions compatibility", () => {
  it("returns null when reactions payload is malformed", () => {
    const result = groupReactions({ not: "an-array" } as unknown as never, new Map());
    expect(result).toBeNull();
  });

  it("ignores malformed reaction entries and groups valid ones", () => {
    const reactions = [
      null,
      "bad-entry",
      { emoji: "", isFromMe: false },
      { emoji: ":+1:", isFromMe: true },
      { emoji: ":+1:", isFromMe: false, contactId: "contact_1" },
      { emoji: ":+1:", isFromMe: false, contactId: "contact_1" },
    ] as unknown as never;

    const result = groupReactions(
      reactions,
      new Map([["contact_1", "Alice"]]),
    );

    expect(result).toEqual([
      {
        emoji: "👍",
        reactors: [
          { displayName: "You", isFromMe: true },
          { displayName: "Alice", isFromMe: false },
        ],
      },
    ]);
  });

  it("collects only valid contact ids from malformed reaction payloads", () => {
    const ids = collectReactionContactIds([
      { reactions: undefined },
      { reactions: { nope: true } as unknown as never },
      {
        reactions: [
          null,
          "x",
          { contactId: 123 },
          { emoji: ":+1:", isFromMe: false, contactId: "contact_2" },
        ] as unknown as never,
      },
    ]);

    expect(ids).toEqual(["contact_2"]);
  });
});
