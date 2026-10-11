import { expect, it } from "vitest";
import { parseSlackCaptureDiagnostic } from "./capture-diagnostics.js";

it("forwards only known stages, never browser errors or injected credential fields", () => {
  expect(
    parseSlackCaptureDiagnostic(
      JSON.stringify({
        provider: "slack",
        captureDiagnostic: "helper_accepted",
        secret: "xoxc-sensitive",
      }),
    ),
  ).toBe("helper_accepted");
  expect(
    parseSlackCaptureDiagnostic(
      JSON.stringify({ provider: "slack", captureDiagnostic: "xoxc-sensitive" }),
    ),
  ).toBeNull();
  expect(parseSlackCaptureDiagnostic("secret-cookie raw browser error")).toBeNull();
  expect(parseSlackCaptureDiagnostic("x".repeat(257))).toBeNull();
});
