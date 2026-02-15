import { describe, expect, it } from "vitest";
import { buildEmbeddingInput } from "./embed";

describe("buildEmbeddingInput", () => {
  it("includes reactions with reactor names in context and trigger lines", () => {
    const input = buildEmbeddingInput(
      {
        content: "Can you send the file?",
        senderName: "Alex",
        reactions: [
          { emoji: "👍", isFromMe: true, timestamp: 2000, reactorName: "Me" },
        ],
      },
      [
        {
          content: "Sure",
          isFromMe: true,
          reactions: [
            { emoji: "❤️", isFromMe: false, timestamp: 1000, reactorName: "Alex" },
          ],
        },
      ],
      "imessage",
      "Alex",
      { conversationType: "dm" }
    );

    expect(input).toContain("Me: Sure (Reactions: Alex ❤️)");
    expect(input).toContain("Alex: Can you send the file? (Reactions: Me 👍)");
  });
});
