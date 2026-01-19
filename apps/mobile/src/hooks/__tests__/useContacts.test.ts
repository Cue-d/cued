import { renderHook } from "@testing-library/react";
import { useQuery } from "convex/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useContacts } from "../useContacts";

// Mock convex/react is already done in setup.ts
vi.mock("convex/react");

const mockUseQuery = vi.mocked(useQuery);

describe("useContacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loading state", () => {
    it("returns isLoading=true when query result is undefined", () => {
      mockUseQuery.mockReturnValue(undefined);

      const { result } = renderHook(() => useContacts());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.contacts).toEqual([]);
    });

    it("returns isLoading=false when query result is available", () => {
      mockUseQuery.mockReturnValue({ contacts: [], nextCursor: null });

      const { result } = renderHook(() => useContacts());

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("contacts data", () => {
    it("returns empty array when no contacts", () => {
      mockUseQuery.mockReturnValue({ contacts: [], nextCursor: null });

      const { result } = renderHook(() => useContacts());

      expect(result.current.contacts).toEqual([]);
    });

    it("returns contacts from query result", () => {
      const mockContacts = [
        {
          _id: "contact1",
          displayName: "John Doe",
          company: "Acme Inc",
          handles: [{ type: "email", value: "john@acme.com" }],
        },
        {
          _id: "contact2",
          displayName: "Jane Smith",
          company: null,
          handles: [{ type: "phone", value: "+15551234567" }],
        },
      ];
      mockUseQuery.mockReturnValue({ contacts: mockContacts, nextCursor: null });

      const { result } = renderHook(() => useContacts());

      expect(result.current.contacts).toEqual(mockContacts);
      expect(result.current.contacts).toHaveLength(2);
    });

    it("returns nextCursor when available", () => {
      const cursorId = "cursor_contact_id" as unknown;
      mockUseQuery.mockReturnValue({ contacts: [], nextCursor: cursorId });

      const { result } = renderHook(() => useContacts());

      expect(result.current.nextCursor).toBe(cursorId);
    });

    it("returns null nextCursor when not available", () => {
      mockUseQuery.mockReturnValue({ contacts: [], nextCursor: null });

      const { result } = renderHook(() => useContacts());

      expect(result.current.nextCursor).toBeNull();
    });
  });

  describe("options", () => {
    it("passes limit option to query", () => {
      mockUseQuery.mockReturnValue({ contacts: [], nextCursor: null });

      renderHook(() => useContacts({ limit: 20 }));

      expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), {
        limit: 20,
        cursor: undefined,
        searchQuery: undefined,
      });
    });

    it("passes cursor option to query", () => {
      const cursorId = "cursor_id" as unknown;
      mockUseQuery.mockReturnValue({ contacts: [], nextCursor: null });

      renderHook(() => useContacts({ cursor: cursorId as never }));

      expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), {
        limit: undefined,
        cursor: cursorId,
        searchQuery: undefined,
      });
    });

    it("passes searchQuery option to query", () => {
      mockUseQuery.mockReturnValue({ contacts: [], nextCursor: null });

      renderHook(() => useContacts({ searchQuery: "john" }));

      expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), {
        limit: undefined,
        cursor: undefined,
        searchQuery: "john",
      });
    });

    it("passes all options to query", () => {
      const cursorId = "cursor_id" as unknown;
      mockUseQuery.mockReturnValue({ contacts: [], nextCursor: null });

      renderHook(() =>
        useContacts({
          limit: 10,
          cursor: cursorId as never,
          searchQuery: "doe",
        })
      );

      expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), {
        limit: 10,
        cursor: cursorId,
        searchQuery: "doe",
      });
    });
  });

  describe("search filtering", () => {
    it("handles empty search query", () => {
      mockUseQuery.mockReturnValue({ contacts: [], nextCursor: null });

      renderHook(() => useContacts({ searchQuery: "" }));

      expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), {
        limit: undefined,
        cursor: undefined,
        searchQuery: "",
      });
    });

    it("handles search query with special characters", () => {
      mockUseQuery.mockReturnValue({ contacts: [], nextCursor: null });

      renderHook(() => useContacts({ searchQuery: "john@example.com" }));

      expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), {
        limit: undefined,
        cursor: undefined,
        searchQuery: "john@example.com",
      });
    });
  });

  describe("error handling", () => {
    it("returns null error (Convex useQuery throws instead of returning error)", () => {
      mockUseQuery.mockReturnValue({ contacts: [], nextCursor: null });

      const { result } = renderHook(() => useContacts());

      expect(result.current.error).toBeNull();
    });
  });

  describe("pagination", () => {
    it("can be called with cursor from previous result", () => {
      const firstPageContacts = [
        { _id: "contact1", displayName: "Alice" },
        { _id: "contact2", displayName: "Bob" },
      ];
      const nextCursor = "contact2" as unknown;
      mockUseQuery.mockReturnValue({ contacts: firstPageContacts, nextCursor });

      const { result } = renderHook(() => useContacts({ limit: 2 }));

      // Verify first page result has cursor for next page
      expect(result.current.contacts).toHaveLength(2);
      expect(result.current.nextCursor).toBe(nextCursor);

      // Second page would be fetched with this cursor
      mockUseQuery.mockReturnValue({
        contacts: [{ _id: "contact3", displayName: "Charlie" }],
        nextCursor: null,
      });

      const { result: secondResult } = renderHook(() =>
        useContacts({ limit: 2, cursor: nextCursor as never })
      );

      expect(secondResult.current.contacts).toHaveLength(1);
      expect(secondResult.current.nextCursor).toBeNull();
    });
  });
});
