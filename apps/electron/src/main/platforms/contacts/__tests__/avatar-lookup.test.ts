import { describe, it, expect, vi } from "vitest";
import { resolveAvatarLookupRequests } from "../avatar-lookup";

describe("resolveAvatarLookupRequests", () => {
  it("returns empty object for empty input", () => {
    expect(resolveAvatarLookupRequests([], vi.fn())).toEqual({});
  });

  it("resolves first avatar match per contact", () => {
    const resolveByHandle = vi.fn((handle: string) => {
      if (handle === "first") return { avatarUrl: null };
      if (handle === "second") return { avatarUrl: "cued-contact-avatar://avatar/a.jpg" };
      return undefined;
    });

    const resolved = resolveAvatarLookupRequests(
      [{ contactId: "c1", handles: ["first", "second", "third"] }],
      resolveByHandle,
    );

    expect(resolved).toEqual({
      c1: "cued-contact-avatar://avatar/a.jpg",
    });
    expect(resolveByHandle).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed requests and empty handles", () => {
    const resolveByHandle = vi.fn(() => ({ avatarUrl: "cued-contact-avatar://avatar/a.jpg" }));

    const resolved = resolveAvatarLookupRequests(
      [
        { contactId: "ok", handles: [""] },
        { contactId: "ok2", handles: ["good"] },
        null as unknown as { contactId: string; handles: string[] },
        { contactId: 123 as unknown as string, handles: ["x"] },
      ],
      resolveByHandle,
    );

    expect(resolved).toEqual({
      ok2: "cued-contact-avatar://avatar/a.jpg",
    });
    expect(resolveByHandle).toHaveBeenCalledTimes(1);
  });
});
