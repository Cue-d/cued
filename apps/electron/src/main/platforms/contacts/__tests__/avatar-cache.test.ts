import { describe, it, expect, beforeEach, vi } from "vitest";

const { fsMocks } = vi.hoisted(() => ({
  fsMocks: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    ...fsMocks,
  };
});

vi.mock("node:os", () => ({
  homedir: () => "/Users/test",
}));

import {
  CONTACT_AVATAR_CACHE_DIR,
  cacheContactAvatar,
  pruneContactAvatarCache,
  resolveContactAvatarPathFromUrl,
} from "../avatar-cache";

describe("avatar-cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores image bytes and returns protocol URL", () => {
    fsMocks.existsSync.mockReturnValue(false);

    const result = cacheContactAvatar("contact-1", Buffer.from([0xff, 0xd8, 0xff, 0xee]));

    expect(result).not.toBeNull();
    expect(result?.url).toMatch(/^cued-contact-avatar:\/\/avatar\//);
    expect(result?.fileName).toMatch(/^[a-f0-9]{64}\.jpg$/);
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(CONTACT_AVATAR_CACHE_DIR, { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns null and avoids writes for empty image data", () => {
    const result = cacheContactAvatar("contact-1", undefined);
    expect(result).toBeNull();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("resolves valid protocol URLs to local cache paths", () => {
    const fileName = `${"a".repeat(64)}.png`;
    const resolved = resolveContactAvatarPathFromUrl(
      `cued-contact-avatar://avatar/${fileName}`,
    );
    expect(resolved).toBe(`${CONTACT_AVATAR_CACHE_DIR}/${fileName}`);
  });

  it("rejects invalid or unsafe protocol URLs", () => {
    expect(resolveContactAvatarPathFromUrl("https://example.com/a.jpg")).toBeNull();
    expect(
      resolveContactAvatarPathFromUrl("cued-contact-avatar://wrong-host/a.jpg"),
    ).toBeNull();
    expect(
      resolveContactAvatarPathFromUrl("cued-contact-avatar://avatar/%2E%2E%2Fsecret"),
    ).toBeNull();
    expect(
      resolveContactAvatarPathFromUrl("cued-contact-avatar://avatar/not-a-hash.jpg"),
    ).toBeNull();
  });

  it("prunes stale files but keeps used entries", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockReturnValue([
      `${"a".repeat(64)}.jpg`,
      `${"b".repeat(64)}.png`,
    ]);

    pruneContactAvatarCache(new Set([`${"a".repeat(64)}.jpg`]));

    expect(fsMocks.unlinkSync).toHaveBeenCalledTimes(1);
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(
      `${CONTACT_AVATAR_CACHE_DIR}/${"b".repeat(64)}.png`,
    );
  });
});
