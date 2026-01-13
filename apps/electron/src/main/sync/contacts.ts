/**
 * Apple Contacts integration for Electron.
 *
 * Fetches contacts from Contacts.app using AppleScript and provides
 * a lookup cache for resolving phone numbers/emails to contact names.
 *
 * Based on backend/services/macos/contacts.py and backend/services/contacts/resolver.py
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ResolvedContact } from "./types";
import { normalizePhone, getPhoneVariants } from "@prm/shared";

/** Default cache directory for contacts */
const CACHE_DIR = join(homedir(), ".prm");
const CACHE_FILE = join(CACHE_DIR, "contacts_cache.json");

/** Cache expiry in milliseconds (24 hours) */
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Timeout for AppleScript in milliseconds */
const APPLESCRIPT_TIMEOUT_MS = 30000;

/** Cached contacts data structure */
interface ContactsCache {
  /** ISO timestamp when cache was created */
  fetchedAt: string;
  /** Contacts indexed by identifier */
  contacts: ResolvedContact[];
  /** Map from normalized handle to contact index for O(1) lookup */
  handleIndex: Record<string, number>;
}

/**
 * AppleScript to fetch all contacts with phone numbers and emails.
 * Returns JSON array of contacts.
 */
const FETCH_CONTACTS_SCRIPT = `
use AppleScript version "2.4"
use scripting additions
use framework "Foundation"

set output to "["
set isFirst to true

tell application "Contacts"
  set allPeople to every person
  repeat with p in allPeople
    set contactName to name of p

    -- Get phone numbers
    set phones to {}
    repeat with ph in (phones of p)
      set end of phones to value of ph
    end repeat

    -- Get emails
    set emails to {}
    repeat with em in (emails of p)
      set end of emails to value of em
    end repeat

    -- Skip contacts with no phone or email
    if (count of phones) > 0 or (count of emails) > 0 then
      -- Get company (may be missing)
      set contactCompany to ""
      try
        set contactCompany to organization of p
      end try

      -- Build JSON object
      set jsonObj to "{"
      set jsonObj to jsonObj & "\\"name\\": \\"" & my escapeJson(contactName) & "\\""

      if contactCompany is not "" then
        set jsonObj to jsonObj & ", \\"company\\": \\"" & my escapeJson(contactCompany) & "\\""
      end if

      set jsonObj to jsonObj & ", \\"phones\\": " & my listToJsonArray(phones)
      set jsonObj to jsonObj & ", \\"emails\\": " & my listToJsonArray(emails)
      set jsonObj to jsonObj & "}"

      if isFirst then
        set isFirst to false
      else
        set output to output & ","
      end if
      set output to output & jsonObj
    end if
  end repeat
end tell

set output to output & "]"
return output

on escapeJson(str)
  set str to my replaceText(str, "\\\\", "\\\\\\\\")
  set str to my replaceText(str, "\\"", "\\\\\\"")
  set str to my replaceText(str, return, "\\\\n")
  set str to my replaceText(str, linefeed, "\\\\n")
  set str to my replaceText(str, tab, "\\\\t")
  return str
end escapeJson

on replaceText(theText, searchString, replacementString)
  set AppleScript's text item delimiters to searchString
  set theItems to every text item of theText
  set AppleScript's text item delimiters to replacementString
  set theResult to theItems as string
  set AppleScript's text item delimiters to ""
  return theResult
end replaceText

on listToJsonArray(theList)
  set output to "["
  set isFirst to true
  repeat with item in theList
    if isFirst then
      set isFirst to false
    else
      set output to output & ","
    end if
    set output to output & "\\"" & my escapeJson(item as string) & "\\""
  end repeat
  return output & "]"
end listToJsonArray
`;

/**
 * Contacts manager that fetches from Contacts.app and provides cached lookup.
 */
export class ContactsManager {
  private cache: ContactsCache | null = null;

  /**
   * Fetch all contacts from Apple Contacts.app.
   * Uses cached data if available and not expired.
   *
   * @param forceRefresh - If true, bypass cache and fetch fresh data
   * @returns List of contacts with phone numbers and emails
   */
  async fetchContacts(forceRefresh = false): Promise<ResolvedContact[]> {
    // Check cache first
    if (!forceRefresh) {
      const cached = this.loadCache();
      if (cached) {
        this.cache = cached;
        return cached.contacts;
      }
    }

    // Fetch from Contacts.app
    const contacts = await this.fetchFromAppleScript();

    // Build cache with index
    this.cache = this.buildCache(contacts);

    // Save cache to disk
    this.saveCache(this.cache);

    return contacts;
  }

  /**
   * Resolve a handle (phone or email) to a contact name.
   *
   * @param handle - Phone number or email address
   * @returns Contact name if found, null otherwise
   */
  resolveHandle(handle: string): string | null {
    const contact = this.findContactByHandle(handle);
    return contact?.displayName ?? null;
  }

  /**
   * Resolve multiple handles to contact names in batch.
   *
   * @param handles - List of phone numbers or email addresses
   * @returns Map from handle to contact name (only includes found handles)
   */
  resolveHandles(handles: string[]): Map<string, string> {
    const result = new Map<string, string>();

    for (const handle of handles) {
      const name = this.resolveHandle(handle);
      if (name) {
        result.set(handle, name);
      }
    }

    return result;
  }

  /**
   * Get the full contact info for a handle.
   *
   * @param handle - Phone number or email address
   * @returns Full contact info if found, null otherwise
   */
  getContact(handle: string): ResolvedContact | null {
    return this.findContactByHandle(handle);
  }

  /**
   * Check if cache is loaded and valid.
   */
  isCacheLoaded(): boolean {
    return this.cache !== null;
  }

  /**
   * Get the number of cached contacts.
   */
  getCacheSize(): number {
    return this.cache?.contacts.length ?? 0;
  }

  /**
   * Clear the in-memory cache (does not delete file).
   */
  clearMemoryCache(): void {
    this.cache = null;
  }

  /**
   * Delete the cached contacts file.
   */
  deleteCacheFile(): void {
    try {
      if (existsSync(CACHE_FILE)) {
        unlinkSync(CACHE_FILE);
      }
    } catch {
      // Ignore errors when deleting cache
    }
  }

  private async fetchFromAppleScript(): Promise<ResolvedContact[]> {
    try {
      const result = execSync(`osascript -e '${FETCH_CONTACTS_SCRIPT}'`, {
        encoding: "utf-8",
        timeout: APPLESCRIPT_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large contact lists
      });

      const parsed = JSON.parse(result) as Array<{
        name: string;
        company?: string;
        phones: string[];
        emails: string[];
      }>;

      return parsed.map((c) => ({
        displayName: c.name,
        company: c.company ?? null,
        phoneNumbers: c.phones,
        emails: c.emails,
      }));
    } catch (error) {
      if (error instanceof Error) {
        // Check for access denied
        if (
          error.message.includes("not allowed assistive access") ||
          error.message.includes("Contacts")
        ) {
          throw new ContactsAccessDeniedError(
            "Contacts access denied. Please grant access in System Preferences > Privacy & Security > Contacts."
          );
        }
        throw new ContactsError(`Failed to fetch contacts: ${error.message}`);
      }
      throw new ContactsError("Failed to fetch contacts: unknown error");
    }
  }

  private buildCache(contacts: ResolvedContact[]): ContactsCache {
    const handleIndex: Record<string, number> = {};

    contacts.forEach((contact, index) => {
      // Index by normalized phone numbers
      for (const phone of contact.phoneNumbers) {
        const normalized = normalizePhone(phone);
        handleIndex[normalized] = index;

        // Also index variants for easier lookup
        const variants = getPhoneVariants(phone);
        for (const variant of variants) {
          handleIndex[variant] = index;
        }
      }

      // Index by lowercase email
      for (const email of contact.emails) {
        handleIndex[email.toLowerCase()] = index;
      }
    });

    return {
      fetchedAt: new Date().toISOString(),
      contacts,
      handleIndex,
    };
  }

  private loadCache(): ContactsCache | null {
    try {
      if (!existsSync(CACHE_FILE)) {
        return null;
      }

      const data = readFileSync(CACHE_FILE, "utf-8");
      const cache = JSON.parse(data) as ContactsCache;

      // Check if cache is expired
      const fetchedAt = new Date(cache.fetchedAt);
      const now = new Date();
      if (now.getTime() - fetchedAt.getTime() > CACHE_EXPIRY_MS) {
        return null;
      }

      return cache;
    } catch {
      return null;
    }
  }

  private saveCache(cache: ContactsCache): void {
    try {
      if (!existsSync(CACHE_DIR)) {
        mkdirSync(CACHE_DIR, { recursive: true });
      }
      writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
    } catch {
      // Ignore cache save errors
    }
  }

  /**
   * Find contact by handle, trying direct lookup then phone variants.
   */
  private findContactByHandle(handle: string): ResolvedContact | null {
    if (!this.cache) {
      return null;
    }

    // Try direct lookup first
    const normalized = this.normalizeHandle(handle);
    const directIndex = this.cache.handleIndex[normalized];
    if (directIndex !== undefined) {
      return this.cache.contacts[directIndex];
    }

    // Try phone variants if it looks like a phone number
    if (this.isPhoneNumber(handle)) {
      for (const variant of getPhoneVariants(handle)) {
        const index = this.cache.handleIndex[variant];
        if (index !== undefined) {
          return this.cache.contacts[index];
        }
      }
    }

    return null;
  }

  private normalizeHandle(handle: string): string {
    if (this.isPhoneNumber(handle)) {
      return normalizePhone(handle);
    }
    return handle.toLowerCase();
  }

  private isPhoneNumber(handle: string): boolean {
    // Matches phone-like strings: optional + followed by digits and formatting chars
    return /^\+?[\d\s().-]+$/.test(handle);
  }
}

/**
 * Error class for contacts-related errors.
 */
export class ContactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactsError";
  }
}

/**
 * Error class for contacts access denied.
 */
export class ContactsAccessDeniedError extends ContactsError {
  constructor(message: string) {
    super(message);
    this.name = "ContactsAccessDeniedError";
  }
}

/**
 * Singleton instance for use across the app.
 */
let defaultManager: ContactsManager | null = null;

/**
 * Get the default ContactsManager instance.
 */
export function getContactsManager(): ContactsManager {
  if (!defaultManager) {
    defaultManager = new ContactsManager();
  }
  return defaultManager;
}

/**
 * Convenience function to resolve a handle using the default manager.
 * Returns null if contacts not loaded yet.
 */
export function resolveHandle(handle: string): string | null {
  return getContactsManager().resolveHandle(handle);
}

/**
 * Convenience function to resolve multiple handles using the default manager.
 */
export function resolveHandles(handles: string[]): Map<string, string> {
  return getContactsManager().resolveHandles(handles);
}
