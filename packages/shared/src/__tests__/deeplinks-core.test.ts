import { describe, expect, it } from "vitest";
import { createDeeplinkUtilities } from "../deeplinks-core";

const { buildHandleDeeplink } = createDeeplinkUtilities({
  extractLinkedInThreadId: (id) => id,
  getPlatformLabel: () => undefined,
});

describe("createDeeplinkUtilities", () => {
  describe("buildHandleDeeplink", () => {
    it("builds a LinkedIn URL from a normalized handle", () => {
      expect(
        buildHandleDeeplink("linkedin", "linkedin_handle", "theotarr")
      ).toBe("https://www.linkedin.com/in/theotarr");
    });

    it("normalizes a LinkedIn profile URL before building deeplink", () => {
      expect(
        buildHandleDeeplink(
          "linkedin",
          "linkedin_handle",
          "https://www.linkedin.com/in/Theo-Tarr/?trk=public_profile"
        )
      ).toBe("https://www.linkedin.com/in/theo-tarr");
    });

    it("returns null for invalid LinkedIn handles", () => {
      expect(
        buildHandleDeeplink("linkedin", "linkedin_handle", "not a valid handle")
      ).toBeNull();
    });

    it("does not deeplink opaque LinkedIn member IDs", () => {
      expect(
        buildHandleDeeplink(
          "linkedin",
          "linkedin_handle",
          "ACoAAEFsIqIBxYzabc123def456ghi"
        )
      ).toBeNull();
    });
  });
});
