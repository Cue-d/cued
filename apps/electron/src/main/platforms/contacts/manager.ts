/**
 * Apple Contacts integration for Electron.
 *
 * Fetches contacts from Contacts.app using node-mac-contacts native module.
 * Provides cached lookup by phone number or email address.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { ResolvedContact } from "../imessage/types";
import { normalizePhone, getPhoneVariants } from "@cued/shared";
import { loadNativeModule } from "../../native-module-loader";
import type { NodeMacContacts } from "./types";
import {
  CONTACTS_CACHE_DIR,
  cacheContactAvatar,
  pruneContactAvatarCache,
} from "./avatar-cache";

/** Default cache directory for contacts */
const CACHE_FILE = join(CONTACTS_CACHE_DIR, "contacts_cache.json");

/** Cache expiry in milliseconds (24 hours) */
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Cached contacts data structure */
interface ContactsCache {
  /** ISO timestamp when cache was created */
  fetchedAt: string;
  /** Contacts indexed by identifier */
  contacts: ResolvedContact[];
  /** Map from normalized handle to contact index for O(1) lookup */
  handleIndex: Record<string, number>;
}

/** Lazily loaded native module */
let _contacts: NodeMacContacts | null = null;

function getContactsModule(): NodeMacContacts {
  if (!_contacts) {
    _contacts = loadNativeModule<NodeMacContacts>("node-mac-contacts");
  }
  return _contacts;
}

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

    // Fetch from Contacts.app via native module
    const contacts = this.fetchFromNativeModule();

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

  private fetchFromNativeModule(): ResolvedContact[] {
    const contacts = getContactsModule();

    const status = contacts.getAuthStatus();
    console.log(`[Contacts] Auth status: ${status}`);
    if (status === "Denied" || status === "Not Authorized") {
      throw new ContactsAccessDeniedError(
        "Contacts access denied. Grant access in System Settings > Privacy & Security > Contacts."
      );
    }

    const start = Date.now();
    const raw = contacts.getAllContacts([
      "organizationName",
      "contactThumbnailImage",
      "contactImage",
    ]);
    console.log(`[Contacts] Fetched ${raw.length} contacts in ${Date.now() - start}ms`);

    const usedAvatarFiles = new Set<string>();
    const resolved = raw.map((c) => {
      const fullName = [c.firstName, c.lastName].filter(Boolean).join(" ");
      const cachedAvatar = cacheContactAvatar(
        c.identifier,
        c.contactThumbnailImage ?? c.contactImage,
      );
      if (cachedAvatar) {
        usedAvatarFiles.add(cachedAvatar.fileName);
      }
      return {
        displayName: fullName || c.organizationName || "Unknown",
        company: c.organizationName ?? null,
        phoneNumbers: c.phoneNumbers,
        emails: c.emailAddresses,
        avatarUrl: cachedAvatar?.url,
      };
    });

    pruneContactAvatarCache(usedAvatarFiles);
    return resolved;
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
      if (!existsSync(CONTACTS_CACHE_DIR)) {
        mkdirSync(CONTACTS_CACHE_DIR, { recursive: true });
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
