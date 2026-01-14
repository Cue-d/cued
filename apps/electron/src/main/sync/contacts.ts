/**
 * Apple Contacts integration for Electron.
 *
 * Fetches contacts from Contacts.app using Swift CLI (prm-contacts) for high performance
 * (~100x faster than AppleScript). Falls back gracefully with clear error messages if unavailable.
 *
 * Based on backend/services/macos/contacts.py
 */

import { execSync } from "child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { ResolvedContact } from "./types";
import { normalizePhone, getPhoneVariants } from "@prm/shared";

/** Default cache directory for contacts */
const CACHE_DIR = join(homedir(), ".prm");
const CACHE_FILE = join(CACHE_DIR, "contacts_cache.json");

/** Cache expiry in milliseconds (24 hours) */
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Timeout for Swift CLI in milliseconds */
const CLI_TIMEOUT_MS = 30000;

/** Environment variable to override the binary path */
const CONTACTS_BINARY_ENV_VAR = "PRM_CONTACTS_BINARY";

/** Cached contacts data structure */
interface ContactsCache {
  /** ISO timestamp when cache was created */
  fetchedAt: string;
  /** Contacts indexed by identifier */
  contacts: ResolvedContact[];
  /** Map from normalized handle to contact index for O(1) lookup */
  handleIndex: Record<string, number>;
}

/** JSON output from prm-contacts CLI */
interface ContactsCliOutput {
  contacts: Array<{
    name: string;
    emails: string[];
    phones: string[];
    company?: string | null;
  }>;
  count: number;
  elapsed_seconds: number;
}

/** JSON error output from prm-contacts CLI */
interface ContactsCliError {
  error: string;
}

/**
 * Get the path to the prm-contacts binary.
 *
 * Checks in order:
 * 1. Environment variable PRM_CONTACTS_BINARY
 * 2. Packaged app location (resources/llm/prm-contacts) - for production
 * 3. Development location (llm/.build/release/prm-contacts) - for development
 */
function getContactsBinaryPath(): string {
  // 1. Check environment variable
  const envPath = process.env[CONTACTS_BINARY_ENV_VAR];
  if (envPath) {
    return envPath;
  }

  // 2. Check packaged app location (Electron resources)
  // When packaged, the structure is: resources/llm/prm-contacts
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    const packagedPath = join(resourcesPath, "llm", "prm-contacts");
    if (existsSync(packagedPath)) {
      return packagedPath;
    }
  }

  // 3. Development location - relative to built output
  // Built file is at: apps/electron/out/main/index.js
  // Binary is at: llm/.build/release/prm-contacts
  const devPath = join(__dirname, "..", "..", "..", "..", "llm", ".build", "release", "prm-contacts");
  return devPath;
}

/**
 * Check if the Swift contacts CLI is available.
 */
export function isSwiftContactsAvailable(): boolean {
  const binaryPath = getContactsBinaryPath();
  try {
    accessSync(binaryPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Contacts manager that fetches from Contacts.app and provides cached lookup.
 */
export class ContactsManager {
  private cache: ContactsCache | null = null;
  private binaryPath: string;

  constructor() {
    this.binaryPath = getContactsBinaryPath();
  }

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

    // Fetch from Contacts.app via Swift CLI
    const contacts = await this.fetchFromSwiftCli();

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

  /**
   * Get the path to the Swift CLI binary being used.
   */
  getBinaryPath(): string {
    return this.binaryPath;
  }

  private async fetchFromSwiftCli(): Promise<ResolvedContact[]> {
    // Check if binary exists
    if (!existsSync(this.binaryPath)) {
      throw new ContactsError(
        `Swift contacts binary not found at ${this.binaryPath}. ` +
        `Build it with: cd llm && swift build -c release --product prm-contacts`
      );
    }

    try {
      const result = execSync(`"${this.binaryPath}" --json`, {
        encoding: "utf-8",
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large contact lists
      });

      const output = JSON.parse(result) as ContactsCliOutput;

      return output.contacts.map((c) => ({
        displayName: c.name,
        company: c.company ?? null,
        phoneNumbers: c.phones,
        emails: c.emails,
      }));
    } catch (error) {
      // Handle execSync errors (includes exit code)
      if (error && typeof error === "object" && "status" in error) {
        const execError = error as { status: number; stderr?: string };

        // Exit code 2 = access denied
        if (execError.status === 2) {
          const errorMsg = this.parseCliError(execError.stderr);
          throw new ContactsAccessDeniedError(
            errorMsg || "Contacts access denied. Grant access in System Settings > Privacy & Security > Contacts."
          );
        }

        // Other exit codes
        const errorMsg = this.parseCliError(execError.stderr);
        throw new ContactsError(errorMsg || `Contacts fetch failed with exit code ${execError.status}`);
      }

      // Generic error
      if (error instanceof Error) {
        throw new ContactsError(`Failed to fetch contacts: ${error.message}`);
      }
      throw new ContactsError("Failed to fetch contacts: unknown error");
    }
  }

  private parseCliError(stderr?: string): string | null {
    if (!stderr) return null;
    try {
      const errorOutput = JSON.parse(stderr.trim()) as ContactsCliError;
      return errorOutput.error;
    } catch {
      return stderr.trim() || null;
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
