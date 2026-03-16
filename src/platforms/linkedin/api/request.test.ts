import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkedInAuthError, linkedInEncode, newGetRequest } from "./request.js";

const cookies = [
  {
    name: "li_at",
    value: "token",
    domain: ".linkedin.com",
    path: "/",
  },
  {
    name: "JSESSIONID",
    value: '"ajax:123"',
    domain: ".linkedin.com",
    path: "/",
  },
];

describe("linkedin request auth invalidation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats cleared li_at cookies as auth invalidation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 200,
            headers: {
              "set-cookie":
                "li_at=; Path=/; Domain=.linkedin.com; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
            },
          }),
      ),
    );

    await expect(
      newGetRequest("https://www.linkedin.com/voyager/api/test", cookies).doRaw(),
    ).rejects.toBeInstanceOf(LinkedInAuthError);
  });

  it("treats delete me li_at cookies as auth invalidation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 200,
            headers: {
              "set-cookie": "li_at=delete me; Path=/; Domain=.linkedin.com",
            },
          }),
      ),
    );

    await expect(
      newGetRequest("https://www.linkedin.com/voyager/api/test", cookies).doRaw(),
    ).rejects.toBeInstanceOf(LinkedInAuthError);
  });

  it("encodes tuple-style linkedin urn parentheses", () => {
    expect(linkedInEncode("urn:li:msg_conversation:(urn:li:fsd_profile:SELF123,CONV123)")).toBe(
      "urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3ASELF123%2CCONV123%29",
    );
  });
});
