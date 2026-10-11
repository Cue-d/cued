import { describe, expect, it, vi } from "vitest";
import { validateBundleSignature } from "./signature.js";

describe("update publisher verification", () => {
  it("requires the pinned Developer ID publisher and bundle before Gatekeeper assessment", () => {
    const run = vi.fn();
    validateBundleSignature("/private/staging/Cued.app", run);
    expect(run.mock.calls).toEqual([
      [
        "/usr/bin/codesign",
        [
          "--verify",
          "--deep",
          "--strict",
          "--test-requirement",
          '=identifier "so.cued.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "8MW6NC736H"',
          "/private/staging/Cued.app",
        ],
      ],
      ["/usr/sbin/spctl", ["--assess", "--type", "execute", "/private/staging/Cued.app"]],
    ]);
  });

  // codesign owns certificate validation; simulate its rejection at the command
  // boundary to ensure no failed verification can fall through to installation.
  it.each([
    "wrong publisher",
    "wrong bundle identifier",
    "ad-hoc signature",
    "modified bundle",
  ])("fails closed when codesign rejects a %s", (reason) => {
    const failure = new Error(reason);
    const run = vi.fn(() => {
      throw failure;
    });
    expect(() => validateBundleSignature("/staging/Cued.app", run)).toThrow(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("also fails closed when Gatekeeper rejects a correctly signed bundle", () => {
    const run = vi.fn((command: string) => {
      if (command === "/usr/sbin/spctl") throw new Error("not notarized");
    });
    expect(() => validateBundleSignature("/staging/Cued.app", run)).toThrow("not notarized");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
