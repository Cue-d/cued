import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ContactsManager, ContactsError, ContactsAccessDeniedError, isSwiftContactsAvailable } from "../contacts";

// Mock fs module
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    accessSync: vi.fn(),
    constants: actual.constants,
  };
});

// Mock child_process
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

// Mock os for homedir
vi.mock("os", () => ({
  homedir: () => "/Users/test",
}));

import { existsSync, readFileSync, writeFileSync, accessSync } from "fs";
import { execSync } from "child_process";

/** Helper to create Swift CLI JSON output format */
function createCliOutput(contacts: Array<{ name: string; phones: string[]; emails: string[]; company?: string }>) {
  return JSON.stringify({
    contacts: contacts.map(c => ({
      name: c.name,
      phones: c.phones,
      emails: c.emails,
      company: c.company ?? null,
    })),
    count: contacts.length,
    elapsed_seconds: 0.05,
  });
}

describe("ContactsManager", () => {
  let manager: ContactsManager;

  beforeEach(() => {
    manager = new ContactsManager();
    vi.clearAllMocks();
    // Default: binary exists
    vi.mocked(existsSync).mockImplementation((path) => {
      if (typeof path === "string" && path.includes("prm-contacts")) {
        return true;
      }
      return false;
    });
  });

  afterEach(() => {
    manager.clearMemoryCache();
  });

  describe("cache behavior", () => {
    it("loads contacts from cache when valid", async () => {
      const cachedData = {
        fetchedAt: new Date().toISOString(),
        contacts: [
          {
            displayName: "John Doe",
            company: "Acme Inc",
            phoneNumbers: ["+15551234567"],
            emails: ["john@example.com"],
          },
        ],
        handleIndex: {
          "+15551234567": 0,
          "5551234567": 0,
          "john@example.com": 0,
        },
      };

      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("contacts_cache.json")) {
          return true;
        }
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(cachedData));

      const contacts = await manager.fetchContacts();

      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe("John Doe");
      expect(execSync).not.toHaveBeenCalled();
    });

    it("skips expired cache and fetches fresh", async () => {
      const expiredCache = {
        fetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
        contacts: [{ displayName: "Old Contact", company: null, phoneNumbers: [], emails: [] }],
        handleIndex: {},
      };

      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("contacts_cache.json")) {
          return true;
        }
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(expiredCache));
      vi.mocked(execSync).mockReturnValue(
        createCliOutput([{ name: "New Contact", phones: ["+15559999999"], emails: [] }])
      );

      const contacts = await manager.fetchContacts();

      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe("New Contact");
      expect(execSync).toHaveBeenCalled();
    });

    it("fetches from Swift CLI when no cache exists", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(execSync).mockReturnValue(
        createCliOutput([{ name: "Jane Smith", company: "Tech Co", phones: ["+15551111111"], emails: ["jane@tech.co"] }])
      );

      const contacts = await manager.fetchContacts();

      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe("Jane Smith");
      expect(contacts[0].company).toBe("Tech Co");
      expect(execSync).toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalled();
    });

    it("forces refresh when requested", async () => {
      const cachedData = {
        fetchedAt: new Date().toISOString(),
        contacts: [{ displayName: "Cached", company: null, phoneNumbers: [], emails: [] }],
        handleIndex: {},
      };

      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("contacts_cache.json")) {
          return true;
        }
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(cachedData));
      vi.mocked(execSync).mockReturnValue(
        createCliOutput([{ name: "Fresh", phones: [], emails: [] }])
      );

      const contacts = await manager.fetchContacts(true);

      expect(contacts[0].displayName).toBe("Fresh");
      expect(execSync).toHaveBeenCalled();
    });
  });

  describe("resolveHandle", () => {
    beforeEach(async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(execSync).mockReturnValue(
        createCliOutput([
          { name: "Alice", phones: ["+15551234567", "+15559876543"], emails: ["alice@example.com"] },
          { name: "Bob", phones: ["555-111-2222"], emails: ["bob@work.com", "bob@personal.com"] },
        ])
      );
      await manager.fetchContacts();
    });

    it("resolves phone number with + prefix", () => {
      expect(manager.resolveHandle("+15551234567")).toBe("Alice");
    });

    it("resolves phone number without + prefix via variants", () => {
      expect(manager.resolveHandle("5551234567")).toBe("Alice");
    });

    it("resolves formatted phone number", () => {
      expect(manager.resolveHandle("(555) 123-4567")).toBe("Alice");
    });

    it("resolves email address", () => {
      expect(manager.resolveHandle("alice@example.com")).toBe("Alice");
    });

    it("resolves email case-insensitively", () => {
      expect(manager.resolveHandle("ALICE@EXAMPLE.COM")).toBe("Alice");
    });

    it("resolves phone stored without country code", () => {
      // Bob's phone is stored as 555-111-2222 (no +1)
      expect(manager.resolveHandle("5551112222")).toBe("Bob");
    });

    it("resolves phone with +1 when stored without", () => {
      // Bob's phone is stored as 555-111-2222, lookup with +1
      expect(manager.resolveHandle("+15551112222")).toBe("Bob");
    });

    it("returns null for unknown handle", () => {
      expect(manager.resolveHandle("+19999999999")).toBeNull();
    });

    it("returns null for unknown email", () => {
      expect(manager.resolveHandle("unknown@example.com")).toBeNull();
    });

    it("returns null when cache not loaded", () => {
      const freshManager = new ContactsManager();
      expect(freshManager.resolveHandle("+15551234567")).toBeNull();
    });
  });

  describe("resolveHandles", () => {
    beforeEach(async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(execSync).mockReturnValue(
        createCliOutput([
          { name: "Alice", phones: ["+15551234567"], emails: [] },
          { name: "Bob", phones: ["+15559999999"], emails: [] },
        ])
      );
      await manager.fetchContacts();
    });

    it("resolves multiple handles at once", () => {
      const result = manager.resolveHandles(["+15551234567", "+15559999999", "+15550000000"]);

      expect(result.size).toBe(2);
      expect(result.get("+15551234567")).toBe("Alice");
      expect(result.get("+15559999999")).toBe("Bob");
      expect(result.has("+15550000000")).toBe(false);
    });
  });

  describe("getContact", () => {
    beforeEach(async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(execSync).mockReturnValue(
        createCliOutput([{ name: "Alice", company: "Acme", phones: ["+15551234567"], emails: ["alice@acme.com"] }])
      );
      await manager.fetchContacts();
    });

    it("returns full contact info", () => {
      const contact = manager.getContact("+15551234567");

      expect(contact).not.toBeNull();
      expect(contact!.displayName).toBe("Alice");
      expect(contact!.company).toBe("Acme");
      expect(contact!.phoneNumbers).toContain("+15551234567");
      expect(contact!.emails).toContain("alice@acme.com");
    });

    it("returns null for unknown handle", () => {
      expect(manager.getContact("+19999999999")).toBeNull();
    });
  });

  describe("error handling", () => {
    it("throws ContactsError when binary not found", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(manager.fetchContacts()).rejects.toThrow(ContactsError);
      await expect(manager.fetchContacts()).rejects.toThrow(/binary not found/);
    });

    it("throws ContactsAccessDeniedError when exit code 2", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(execSync).mockImplementation(() => {
        const error = new Error("Command failed") as Error & { status: number; stderr: string };
        error.status = 2;
        error.stderr = JSON.stringify({ error: "Contacts access denied" });
        throw error;
      });

      await expect(manager.fetchContacts()).rejects.toThrow(ContactsAccessDeniedError);
    });

    it("throws ContactsError for other exit codes", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(execSync).mockImplementation(() => {
        const error = new Error("Command failed") as Error & { status: number; stderr: string };
        error.status = 1;
        error.stderr = JSON.stringify({ error: "Some other error" });
        throw error;
      });

      await expect(manager.fetchContacts()).rejects.toThrow(ContactsError);
      await expect(manager.fetchContacts()).rejects.toThrow("Some other error");
    });
  });

  describe("cache state", () => {
    it("isCacheLoaded returns false initially", () => {
      expect(manager.isCacheLoaded()).toBe(false);
    });

    it("isCacheLoaded returns true after fetch", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(execSync).mockReturnValue(createCliOutput([]));

      await manager.fetchContacts();

      expect(manager.isCacheLoaded()).toBe(true);
    });

    it("getCacheSize returns contact count", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(execSync).mockReturnValue(
        createCliOutput([
          { name: "A", phones: ["1"], emails: [] },
          { name: "B", phones: ["2"], emails: [] },
        ])
      );

      await manager.fetchContacts();

      expect(manager.getCacheSize()).toBe(2);
    });

    it("clearMemoryCache resets state", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("prm-contacts")) {
          return true;
        }
        return false;
      });
      vi.mocked(execSync).mockReturnValue(createCliOutput([{ name: "Test", phones: ["1"], emails: [] }]));

      await manager.fetchContacts();
      expect(manager.isCacheLoaded()).toBe(true);

      manager.clearMemoryCache();
      expect(manager.isCacheLoaded()).toBe(false);
    });
  });

  describe("getBinaryPath", () => {
    it("returns the binary path", () => {
      const path = manager.getBinaryPath();
      expect(path).toContain("prm-contacts");
    });
  });
});

describe("isSwiftContactsAvailable", () => {
  it("returns true when binary is executable", () => {
    vi.mocked(accessSync).mockImplementation(() => {});
    expect(isSwiftContactsAvailable()).toBe(true);
  });

  it("returns false when binary is not executable", () => {
    vi.mocked(accessSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(isSwiftContactsAvailable()).toBe(false);
  });
});

describe("ContactsError classes", () => {
  it("ContactsError has correct name", () => {
    const error = new ContactsError("test");
    expect(error.name).toBe("ContactsError");
    expect(error.message).toBe("test");
  });

  it("ContactsAccessDeniedError has correct name", () => {
    const error = new ContactsAccessDeniedError("test");
    expect(error.name).toBe("ContactsAccessDeniedError");
    expect(error.message).toBe("test");
  });

  it("ContactsAccessDeniedError is instanceof ContactsError", () => {
    const error = new ContactsAccessDeniedError("test");
    expect(error).toBeInstanceOf(ContactsError);
  });
});
