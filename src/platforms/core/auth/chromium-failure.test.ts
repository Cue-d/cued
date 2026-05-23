import { describe, expect, it } from "vitest";
import { classifyChromiumAuthWaitFailure } from "./chromium-failure.js";

describe("classifyChromiumAuthWaitFailure", () => {
  it("keeps ordinary wait exhaustion classified as an auth timeout", () => {
    expect(classifyChromiumAuthWaitFailure(null)).toEqual({
      errorCode: "auth_timeout",
      stage: "wait_for_auth",
    });
  });

  it("classifies current extraction errors separately from wait timeouts", () => {
    expect(classifyChromiumAuthWaitFailure("LinkedIn cookies were unavailable")).toEqual({
      errorCode: "auth_extraction_failed",
      stage: "extract_auth",
    });
  });
});
