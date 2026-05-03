import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ContactObservationPayload } from "../../core/types/provider.js";
import {
  getMacOSNativeBinaryCandidates,
  resolveMacOSNativeBinary,
} from "../../runtime/native-binary.js";
import type { SyncBundle } from "../core/sync.js";

export interface ContactRecordInput {
  sourceId: string;
  displayName: string;
  company?: string | null;
  avatarUrl?: string | null;
  phoneNumbers?: string[];
  emails?: string[];
}

type ContactsLoader =
  | { kind: "file"; path: string }
  | { kind: "native"; path: string }
  | { kind: "jxa" };

function dedupeKey(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function loadContactsFromFile(path: string): ContactRecordInput[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as
    | ContactRecordInput[]
    | {
        contacts?: Array<{
          displayName?: string;
          company?: string | null;
          avatarUrl?: string | null;
          phoneNumbers?: string[];
          emails?: string[];
        }>;
      };

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed && Array.isArray(parsed.contacts)) {
    return parsed.contacts.map((contact) => {
      const phones = contact.phoneNumbers ?? [];
      const emails = contact.emails ?? [];
      const name = contact.displayName?.trim() || "Unknown";
      return {
        sourceId: dedupeKey(`contacts-cache:${name}:${phones.join(",")}:${emails.join(",")}`),
        displayName: name,
        company: contact.company ?? null,
        avatarUrl: contact.avatarUrl ?? null,
        phoneNumbers: phones,
        emails,
      };
    });
  }

  throw new Error(`Unsupported contacts file shape: ${path}`);
}

function loadContactsFromNativeBinary(path: string): ContactRecordInput[] {
  const statusStdout = execFileSync(path, ["contacts", "status"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const status = JSON.parse(statusStdout) as { status?: string };
  if (status.status !== "authorized") {
    throw new Error(`Contacts permission is ${status.status ?? "unknown"}`);
  }

  const stdout = execFileSync(path, ["contacts", "dump"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return JSON.parse(stdout) as ContactRecordInput[];
}

function loadContactsFromMacOS(): ContactRecordInput[] {
  const script = `
    ObjC.import('Foundation');
    const app = Application('Contacts');
    const people = app.people();
    const output = [];

    for (let i = 0; i < people.length; i += 1) {
      const person = people[i];
      const phones = [];
      const emails = [];

      const phonesValue = person.phones();
      for (let j = 0; j < phonesValue.length; j += 1) {
        phones.push(String(phonesValue[j].value()));
      }

      const emailsValue = person.emails();
      for (let j = 0; j < emailsValue.length; j += 1) {
        emails.push(String(emailsValue[j].value()));
      }

      output.push({
        sourceId: String(person.id()),
        displayName: [String(person.firstName() || ''), String(person.lastName() || '')].join(' ').trim() || String(person.organization() || 'Unknown'),
        company: String(person.organization() || '') || null,
        avatarUrl: null,
        phoneNumbers: phones,
        emails: emails,
      });
    }

    JSON.stringify(output);
  `;

  const stdout = execFileSync("osascript", ["-l", "JavaScript", "-e", script], {
    encoding: "utf8",
  });
  return JSON.parse(stdout) as ContactRecordInput[];
}

export const getNativeContactsBinaryCandidates = getMacOSNativeBinaryCandidates;

export function resolveContactsLoader(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot?: string,
): ContactsLoader {
  if (env.CUED_CONTACTS_JSON_PATH) {
    return { kind: "file", path: env.CUED_CONTACTS_JSON_PATH };
  }

  const nativeBinary = resolveMacOSNativeBinary(env.CUED_CONTACTS_NATIVE_BINARY, repoRoot);
  if (nativeBinary) {
    return { kind: "native", path: nativeBinary };
  }

  return { kind: "jxa" };
}

export function buildContactsSyncBundle(): SyncBundle {
  const loader = resolveContactsLoader();
  const contacts =
    loader.kind === "file"
      ? loadContactsFromFile(loader.path)
      : loader.kind === "native"
        ? loadContactsFromNativeBinary(loader.path)
        : loadContactsFromMacOS();

  const observedBase = Date.now();

  return {
    sourceAccounts: [
      {
        platform: "contacts",
        accountKey: "local",
        displayName: "macOS Contacts",
      },
    ],
    rawEvents: contacts.map((contact, index) => ({
      id: randomUUID(),
      platform: "contacts",
      accountKey: "local",
      entityKind: "contact",
      eventKind: "observed",
      externalEntityId: contact.sourceId,
      observedAt: observedBase + index,
      dedupeKey: dedupeKey(
        `contacts:${contact.sourceId}:${contact.displayName}:${(contact.phoneNumbers ?? []).join(",")}:${(contact.emails ?? []).join(",")}`,
      ),
      payload: {
        sourceEntityKey: `contacts:${contact.sourceId}`,
        fields: {
          display_name: contact.displayName,
          photo_url: contact.avatarUrl ?? null,
          company: contact.company ?? null,
        },
        handles: [
          ...(contact.phoneNumbers ?? []).map((value) => ({
            type: "phone",
            value,
            deterministic: true,
          })),
          ...(contact.emails ?? []).map((value) => ({
            type: "email",
            value,
            deterministic: true,
          })),
        ],
      } satisfies ContactObservationPayload,
      sourceVersion: "contacts-v1",
    })),
    sourceCursor: { snapshotAt: observedBase },
    syncMode: "full",
  };
}
