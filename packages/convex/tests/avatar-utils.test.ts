import { describe, expect, it } from "vitest";
import {
  getContactAvatarOptions,
  upsertContactAvatarOption,
  buildPrimaryAvatarFields,
  normalizeContactAvatarOption,
} from "../convex/lib/avatar";

describe("convex avatar utils", () => {
  it("prefers higher-priority sources over newer lower-priority ones", () => {
    const options = getContactAvatarOptions({
      avatarOptions: [
        {
          url: "https://example.com/imessage.jpg",
          sourcePlatform: "imessage",
          updatedAt: 9999,
        },
        {
          url: "https://example.com/linkedin.jpg",
          sourcePlatform: "linkedin",
          updatedAt: 100,
        },
      ],
    });

    expect(options[0]).toEqual({
      url: "https://example.com/linkedin.jpg",
      sourcePlatform: "linkedin",
      updatedAt: 100,
    });
  });

  it("filters malformed or non-http avatar URLs", () => {
    const options = getContactAvatarOptions({
      avatarOptions: [
        {
          url: "not-a-url",
          sourcePlatform: "twitter",
          updatedAt: 1,
        },
        {
          url: "cued-contact-avatar://avatar/a.jpg",
          sourcePlatform: "imessage",
          updatedAt: 2,
        },
      ],
      avatarUrl: "https://example.com/legacy.jpg",
      avatarSourcePlatform: "slack",
      avatarUpdatedAt: 3,
    });

    expect(options).toEqual([
      {
        url: "https://example.com/legacy.jpg",
        sourcePlatform: "slack",
        updatedAt: 3,
      },
    ]);
  });

  it("upserts options by source and keeps latest value for that source", () => {
    const initial = [
      {
        url: "https://example.com/a.jpg",
        sourcePlatform: "twitter" as const,
        updatedAt: 10,
      },
      {
        url: "https://example.com/b.jpg",
        sourcePlatform: "linkedin" as const,
        updatedAt: 5,
      },
    ];

    const next = upsertContactAvatarOption(initial, {
      url: "https://example.com/c.jpg",
      sourcePlatform: "twitter",
      updatedAt: 11,
    });

    expect(next.filter((o) => o.sourcePlatform === "twitter")).toEqual([
      {
        url: "https://example.com/c.jpg",
        sourcePlatform: "twitter",
        updatedAt: 11,
      },
    ]);
  });

  it("builds empty primary fields for no options", () => {
    expect(buildPrimaryAvatarFields([])).toEqual({
      avatarUrl: undefined,
      avatarSourcePlatform: undefined,
      avatarUpdatedAt: undefined,
    });
  });

  it("preserves best avatar when merging source options", () => {
    const primary = getContactAvatarOptions({
      avatarOptions: [
        {
          url: "https://example.com/linkedin.jpg",
          sourcePlatform: "linkedin",
          updatedAt: 100,
        },
      ],
    });
    const secondary = getContactAvatarOptions({
      avatarOptions: [
        {
          url: "https://example.com/slack.jpg",
          sourcePlatform: "slack",
          updatedAt: 1000,
        },
      ],
    });

    let merged = primary;
    for (const option of secondary) {
      merged = upsertContactAvatarOption(merged, option);
    }

    expect(buildPrimaryAvatarFields(merged)).toEqual({
      avatarUrl: "https://example.com/linkedin.jpg",
      avatarSourcePlatform: "linkedin",
      avatarUpdatedAt: 100,
    });
  });

  it("normalizes valid avatar options and rejects invalid ones", () => {
    expect(
      normalizeContactAvatarOption({
        url: "https://example.com/a.jpg",
        sourcePlatform: "twitter",
        updatedAt: 5,
      }),
    ).toEqual({
      url: "https://example.com/a.jpg",
      sourcePlatform: "twitter",
      updatedAt: 5,
    });

    expect(
      normalizeContactAvatarOption({
        url: "file:///tmp/a.jpg",
        sourcePlatform: "imessage",
      }),
    ).toBeUndefined();
  });
});
