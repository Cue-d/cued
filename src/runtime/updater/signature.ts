import { execFileSync } from "node:child_process";
import { CUED_APP_BUNDLE_IDENTIFIER } from "../../core/identity.js";

// Release publisher verified against the installed Developer ID signature. Keep this
// policy in trusted app code; a downloaded bundle must never supply its own trust pin.
const RELEASE_TEAM_ID = "8MW6NC736H";
const RELEASE_REQUIREMENT = [
  `identifier "${CUED_APP_BUNDLE_IDENTIFIER}"`,
  "anchor apple generic",
  "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
  "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
  `certificate leaf[subject.OU] = "${RELEASE_TEAM_ID}"`,
].join(" and ");

type RunVerification = (command: string, args: string[]) => void;

export function validateBundleSignature(
  appPath: string,
  run: RunVerification = (command, args) => {
    execFileSync(command, args, { stdio: "ignore" });
  },
): void {
  run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--test-requirement",
    `=${RELEASE_REQUIREMENT}`,
    appPath,
  ]);
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath]);
}
