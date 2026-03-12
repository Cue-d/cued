import { describe, expect, it } from "vitest";
import {
  summarizePermissionStatuses,
  type PermissionCheckSummaryInput,
} from "../diagnostics/doctor.js";

function makeInput(
  overrides: Partial<PermissionCheckSummaryInput> = {},
): PermissionCheckSummaryInput {
  return {
    contacts: {
      name: "contacts_permission",
      status: "ok",
      summary: "Contacts access is authorized",
    },
    messagesAutomation: {
      name: "messages_automation",
      status: "ok",
      summary: "Apple Events automation access for Messages is available",
    },
    messagesDatabase: {
      name: "messages_database",
      status: "ok",
      summary: "Messages database is readable",
    },
    messagesNativeHelper: {
      name: "messages_native_helper",
      status: "ok",
      summary: "Native Messages helper can read the Messages database",
    },
    ...overrides,
  };
}

describe("permission status summaries", () => {
  it("maps successful checks to granted permissions", () => {
    expect(summarizePermissionStatuses(makeInput())).toEqual([
      expect.objectContaining({
        key: "contacts",
        status: "granted",
        requestFlags: ["--contacts"],
      }),
      expect.objectContaining({
        key: "full_disk_access",
        status: "granted",
        requestFlags: ["--full-disk-access"],
      }),
      expect.objectContaining({
        key: "messages_automation",
        status: "granted",
        requestFlags: ["--messages"],
      }),
    ]);
  });

  it("marks full disk access as needing action when Messages access fails", () => {
    expect(
      summarizePermissionStatuses(
        makeInput({
          messagesDatabase: {
            name: "messages_database",
            status: "error",
            summary: "Messages database is not readable from the current process",
          },
        }),
      )[1],
    ).toEqual(
      expect.objectContaining({
        key: "full_disk_access",
        status: "needs_action",
        summary: "Messages database is not readable from the current process",
      }),
    );
  });

  it("preserves unknown helper state for full disk access when only the native helper is unavailable", () => {
    expect(
      summarizePermissionStatuses(
        makeInput({
          messagesNativeHelper: {
            name: "messages_native_helper",
            status: "unknown",
            summary: "Native Messages helper is not built",
          },
        }),
      )[1],
    ).toEqual(
      expect.objectContaining({
        key: "full_disk_access",
        status: "granted",
      }),
    );
  });

  it("marks non-ok contacts and Messages automation checks as needing action", () => {
    const permissions = summarizePermissionStatuses(
      makeInput({
        contacts: {
          name: "contacts_permission",
          status: "warning",
          summary: "Contacts access is not determined",
        },
        messagesAutomation: {
          name: "messages_automation",
          status: "warning",
          summary: "Apple Events automation for Messages is not verified",
        },
      }),
    );

    expect(permissions[0]).toEqual(
      expect.objectContaining({
        key: "contacts",
        status: "needs_action",
      }),
    );
    expect(permissions[2]).toEqual(
      expect.objectContaining({
        key: "messages_automation",
        status: "needs_action",
      }),
    );
  });
});
