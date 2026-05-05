import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import {
  buildAuthDiagnostics,
  type PermissionCheckSummaryInput,
  summarizePermissionStatuses,
} from "./doctor.js";

function makeInput(
  overrides: Partial<PermissionCheckSummaryInput> = {},
): PermissionCheckSummaryInput {
  return {
    contacts: {
      name: "contacts_permission",
      status: "ok",
      summary: "Contacts access is authorized",
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
  const tempDirs: string[] = [];
  const originalGoogleClientFile = process.env.CUED_GOOGLE_OAUTH_CLIENT_FILE;

  afterEach(() => {
    if (originalGoogleClientFile === undefined) {
      delete process.env.CUED_GOOGLE_OAUTH_CLIENT_FILE;
    } else {
      process.env.CUED_GOOGLE_OAUTH_CLIENT_FILE = originalGoogleClientFile;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-auth-doctor-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

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

  it("keeps not-determined Contacts promptable", () => {
    const permissions = summarizePermissionStatuses(
      makeInput({
        contacts: {
          name: "contacts_permission",
          status: "warning",
          summary: "Contacts access is not determined",
        },
      }),
    );

    expect(permissions[0]).toEqual(
      expect.objectContaining({
        key: "contacts",
        status: "unknown",
      }),
    );
    expect(permissions.map((permission) => permission.key)).toEqual([
      "contacts",
      "full_disk_access",
    ]);
  });

  it("reports auth diagnostics for every setup platform without requiring broad keychain access", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-missing-google-client-"));
    tempDirs.push(dir);
    process.env.CUED_GOOGLE_OAUTH_CLIENT_FILE = join(dir, "missing-client.json");
    const db = createDb();

    const diagnostics = buildAuthDiagnostics(db);

    expect(diagnostics.map((item) => item.platform)).toEqual(
      expect.arrayContaining([
        "contacts",
        "gmail",
        "imessage",
        "linkedin",
        "signal",
        "slack",
        "whatsapp",
      ]),
    );
    expect(diagnostics.find((item) => item.platform === "gmail")).toEqual(
      expect.objectContaining({
        credentialSource: "google_oauth_loopback_pkce",
        checks: expect.arrayContaining(["missing_google_oauth_client"]),
      }),
    );

    db.close();
  });
});
