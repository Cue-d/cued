import { readFileSync } from "node:fs";
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

  it("keeps the standalone installer pinned to the identical signing policy", () => {
    const run = vi.fn();
    validateBundleSignature("/staging/Cued.app", run);
    const requirement = run.mock.calls[0]?.[1][4];
    const installer = readFileSync(
      new URL("../../../scripts/install-cued-release.sh", import.meta.url),
      "utf8",
    );
    expect(requirement).toBeTypeOf("string");
    expect(installer).toContain(`local release_requirement='${requirement}'`);
    expect(installer).toContain(
      '/usr/bin/codesign --verify --deep --strict --test-requirement "$release_requirement" "$app_path"',
    );
    expect(installer).toContain('/usr/sbin/spctl --assess --type execute "$app_path"');
  });

  // codesign owns certificate validation; simulate its rejection at the command
  // boundary to ensure no failed verification can fall through to installation.
  it("fails closed when codesign rejects the bundle", () => {
    const failure = new Error("signature verification failed");
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
