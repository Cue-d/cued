import { describe, expect, it } from "vitest";
import { parseOAuthAuthHelperResult } from "./oauth.js";

describe("OAuth auth helper result parsing", () => {
  it("rejects malformed successful helper output", () => {
    expect(() =>
      parseOAuthAuthHelperResult({
        code: 0,
        stdout: "{not-json",
        stderr: "",
      }),
    ).toThrow("OAuth auth helper returned invalid JSON");
  });

  it("returns stderr for failed helper output", () => {
    expect(() =>
      parseOAuthAuthHelperResult({
        code: 1,
        stdout: "",
        stderr: "missing config",
      }),
    ).toThrow("missing config");
  });
});
