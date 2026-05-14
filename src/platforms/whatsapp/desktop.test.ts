import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import { buildWhatsAppDesktopSyncBundle, inspectWhatsAppDesktopSource } from "./desktop.js";

const appleBase = 978_307_200;

describe("whatsapp desktop import", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createSource(): string {
    const dir = mkdtempSync(join(tmpdir(), "cued-whatsapp-desktop-source-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "Message", "Media"), { recursive: true });

    const chat = new Database(join(dir, "ChatStorage.sqlite"));
    chat.exec(`
      CREATE TABLE ZWACHATSESSION (
        Z_PK INTEGER PRIMARY KEY,
        ZCONTACTJID TEXT,
        ZPARTNERNAME TEXT,
        ZLASTMESSAGEDATE REAL,
        ZUNREADCOUNT INTEGER,
        ZARCHIVED INTEGER,
        ZREMOVED INTEGER,
        ZHIDDEN INTEGER,
        ZSESSIONTYPE INTEGER
      );
      CREATE TABLE ZWAGROUPMEMBER (
        Z_PK INTEGER PRIMARY KEY,
        ZCHATSESSION INTEGER,
        ZMEMBERJID TEXT,
        ZCONTACTNAME TEXT,
        ZFIRSTNAME TEXT,
        ZISADMIN INTEGER,
        ZISACTIVE INTEGER
      );
      CREATE TABLE ZWAMEDIAITEM (
        Z_PK INTEGER PRIMARY KEY,
        ZMEDIALOCALPATH TEXT,
        ZMEDIAURL TEXT,
        ZTITLE TEXT,
        ZVCARDNAME TEXT,
        ZFILESIZE INTEGER
      );
      CREATE TABLE ZWAMESSAGE (
        Z_PK INTEGER PRIMARY KEY,
        ZCHATSESSION INTEGER,
        ZGROUPMEMBER INTEGER,
        ZMEDIAITEM INTEGER,
        ZSTANZAID TEXT,
        ZISFROMME INTEGER,
        ZMESSAGEDATE REAL,
        ZTEXT TEXT,
        ZMESSAGETYPE INTEGER,
        ZSTARRED INTEGER,
        ZFROMJID TEXT,
        ZTOJID TEXT,
        ZPUSHNAME TEXT
      );
    `);
    chat
      .prepare("INSERT INTO ZWACHATSESSION VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        1,
        "15550100001@s.whatsapp.net",
        "Avery Example",
        1_700_000_020 - appleBase,
        0,
        0,
        0,
        0,
        0,
      );
    chat
      .prepare("INSERT INTO ZWACHATSESSION VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(2, "123456789@g.us", "Launch Group", 1_700_000_030 - appleBase, 2, 0, 0, 0, 0);
    chat
      .prepare("INSERT INTO ZWAGROUPMEMBER VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(10, 2, "15550100002@s.whatsapp.net", "Blake Example", "Blake", 0, 1);
    chat
      .prepare("INSERT INTO ZWAMEDIAITEM VALUES (?, ?, ?, ?, ?, ?)")
      .run(20, "Message/Media/file.pdf", "https://media.example.test/file.pdf", "Brief", "", 1234);
    chat
      .prepare("INSERT INTO ZWAMESSAGE VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        100,
        1,
        null,
        null,
        "wamid-dm-1",
        0,
        1_700_000_000 - appleBase,
        "hello from desktop",
        0,
        0,
        "15550100001@s.whatsapp.net",
        "",
        "Avery",
      );
    chat
      .prepare("INSERT INTO ZWAMESSAGE VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        101,
        2,
        10,
        20,
        "wamid-group-1",
        0,
        1_700_000_030 - appleBase,
        "",
        8,
        0,
        "",
        "",
        "Blake",
      );
    chat
      .prepare("INSERT INTO ZWAMESSAGE VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        102,
        1,
        null,
        null,
        "",
        1,
        1_700_000_040 - appleBase,
        "local desktop-only row",
        0,
        0,
        "",
        "15550100001@s.whatsapp.net",
        "",
      );
    chat
      .prepare("INSERT INTO ZWAMESSAGE VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(103, 1, null, null, "wamid-invalid-date", 0, null, "missing date", 0, 0, "", "", "");
    chat.close();

    const contacts = new Database(join(dir, "ContactsV2.sqlite"));
    contacts.exec(`
      CREATE TABLE ZWAADDRESSBOOKCONTACT (
        ZWHATSAPPID TEXT,
        ZPHONENUMBER TEXT,
        ZFULLNAME TEXT,
        ZGIVENNAME TEXT,
        ZLASTNAME TEXT,
        ZBUSINESSNAME TEXT,
        ZUSERNAME TEXT,
        ZLID TEXT,
        ZABOUTTEXT TEXT,
        ZLASTUPDATED REAL
      );
      INSERT INTO ZWAADDRESSBOOKCONTACT VALUES
        ('15550100001@s.whatsapp.net', '+15550100001', 'Avery Example', 'Avery', '', '', '', '', '', 0),
        ('15550100002@s.whatsapp.net', '+15550100002', 'Blake Example', 'Blake', '', '', '', '', '', 0);
    `);
    contacts.close();
    return dir;
  }

  it("inspects a WhatsApp Desktop source without importing live files directly", () => {
    const source = createSource();

    expect(inspectWhatsAppDesktopSource(source)).toEqual(
      expect.objectContaining({
        available: true,
        chatRows: 2,
        contactRows: 2,
        messageRows: 4,
        oldestMessageAt: 1_700_000_000_000,
        newestMessageAt: 1_700_000_040_000,
      }),
    );
  });

  it("builds raw events and a desktop coverage proof from a copied snapshot", () => {
    const source = createSource();
    const bundle = buildWhatsAppDesktopSyncBundle({
      sourcePath: source,
      accountKey: "default",
      observedBase: 1_800_000_000_000,
    });

    expect(bundle.sourceAccounts).toEqual([
      { platform: "whatsapp", accountKey: "default", displayName: "WhatsApp Desktop" },
    ]);
    expect(bundle.hasMore).toBe(false);
    expect(bundle.rawEvents.map((event) => event.entityKind)).toEqual([
      "contact",
      "contact",
      "conversation",
      "conversation",
      "message",
      "message",
      "message",
    ]);
    expect(bundle.rawEvents.find((event) => event.entityKind === "message")).toMatchObject({
      platform: "whatsapp",
      sourceVersion: "whatsapp-v1",
      provenance: {
        acquisitionMode: "sync",
        adapterVersion: "whatsapp-desktop-db",
      },
    });
    expect(bundle.proofs?.[0]).toEqual(
      expect.objectContaining({
        proofKind: "messages",
        status: "complete",
        scope: expect.objectContaining({
          metadata: { source: "desktop_db" },
        }),
        coverage: expect.objectContaining({
          source: "desktop_db",
          newestMessageAt: 1_700_000_040_000,
        }),
      }),
    );
    const sourceCursor = bundle.sourceCursor as { desktopDb?: Record<string, unknown> };
    expect(sourceCursor.desktopDb).toEqual(
      expect.objectContaining({
        source: "desktop_db",
        messageRows: 4,
      }),
    );
    expect(JSON.stringify(bundle.proofs)).not.toContain(source);
    expect(JSON.stringify(bundle.sourceCursor)).not.toContain(source);
    expect(JSON.stringify(bundle.diagnostics)).not.toContain(source);
    expect(
      bundle.rawEvents.some(
        (event) =>
          event.entityKind === "message" &&
          JSON.stringify(event.payload).includes("desktop-local:102"),
      ),
    ).toBe(true);
    expect(
      bundle.rawEvents.some(
        (event) =>
          event.entityKind === "message" &&
          JSON.stringify(event.payload).includes("wamid-invalid-date"),
      ),
    ).toBe(false);
    expect(
      bundle.rawEvents.some(
        (event) =>
          event.entityKind === "message" &&
          JSON.stringify(event.payload).includes("Message/Media/file.pdf"),
      ),
    ).toBe(true);
  });
});
