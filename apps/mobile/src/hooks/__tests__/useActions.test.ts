import { renderHook } from "@testing-library/react";
import { useQuery } from "convex/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateWidgetActionsList } from "@/lib/widget-data";
import { useActions } from "../useActions";

// Mock convex/react is already done in setup.ts
vi.mock("convex/react");
vi.mock("@/lib/widget-data", () => ({
  updateWidgetData: vi.fn(),
  updateWidgetActionsList: vi.fn(),
}));

const mockUseQuery = vi.mocked(useQuery);
const mockUpdateWidgetActionsList = vi.mocked(updateWidgetActionsList);

describe("useActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loading state", () => {
    it("returns isLoading=true when query result is undefined", () => {
      mockUseQuery.mockReturnValue(undefined);

      const { result } = renderHook(() => useActions());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.actions).toEqual([]);
    });

    it("returns isLoading=false when query result is available", () => {
      mockUseQuery.mockReturnValue({ actions: [], nextCursor: null });

      const { result } = renderHook(() => useActions());

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("actions data", () => {
    it("returns empty array when no actions", () => {
      mockUseQuery.mockReturnValue({ actions: [], nextCursor: null });

      const { result } = renderHook(() => useActions());

      expect(result.current.actions).toEqual([]);
    });

    it("returns actions from query result", () => {
      const mockActions = [
        {
          _id: "action1",
          contactName: "John Doe",
          platform: "imessage",
          type: "message_response",
          priority: 100,
          createdAt: 1234567890,
        },
        {
          _id: "action2",
          contactName: "Jane Smith",
          platform: "gmail",
          type: "new_connection",
          priority: 50,
          createdAt: 1234567891,
        },
      ];
      mockUseQuery.mockReturnValue({ actions: mockActions, nextCursor: null });

      const { result } = renderHook(() => useActions());

      expect(result.current.actions).toEqual(mockActions);
      expect(result.current.actions).toHaveLength(2);
    });

    it("returns nextCursor when available", () => {
      mockUseQuery.mockReturnValue({ actions: [], nextCursor: 123456 });

      const { result } = renderHook(() => useActions());

      expect(result.current.nextCursor).toBe(123456);
    });

    it("returns null nextCursor when not available", () => {
      mockUseQuery.mockReturnValue({ actions: [], nextCursor: null });

      const { result } = renderHook(() => useActions());

      expect(result.current.nextCursor).toBeNull();
    });
  });

  describe("options", () => {
    it("passes limit option to query", () => {
      mockUseQuery.mockReturnValue({ actions: [], nextCursor: null });

      renderHook(() => useActions({ limit: 10 }));

      expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), {
        limit: 10,
        cursor: undefined,
      });
    });

    it("passes cursor option to query", () => {
      mockUseQuery.mockReturnValue({ actions: [], nextCursor: null });

      renderHook(() => useActions({ cursor: 999 }));

      expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), {
        limit: undefined,
        cursor: 999,
      });
    });

    it("passes both limit and cursor options to query", () => {
      mockUseQuery.mockReturnValue({ actions: [], nextCursor: null });

      renderHook(() => useActions({ limit: 5, cursor: 100 }));

      expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), {
        limit: 5,
        cursor: 100,
      });
    });
  });

  describe("widget sync", () => {
    it("updates widget with actions data", () => {
      const mockActions = [
        {
          _id: "action1",
          contactName: "John Doe",
          platform: "imessage",
          type: "message_response",
        },
      ];
      mockUseQuery.mockReturnValue({ actions: mockActions, nextCursor: null });

      renderHook(() => useActions());

      expect(mockUpdateWidgetActionsList).toHaveBeenCalledWith([
        {
          id: "action1",
          contactName: "John Doe",
          platform: "imessage",
          type: "message_response",
        },
      ]);
    });

    it("updates widget with 'Unknown' when contactName is null", () => {
      const mockActions = [
        {
          _id: "action1",
          contactName: null,
          platform: "gmail",
          type: "new_connection",
        },
      ];
      mockUseQuery.mockReturnValue({ actions: mockActions, nextCursor: null });

      renderHook(() => useActions());

      expect(mockUpdateWidgetActionsList).toHaveBeenCalledWith([
        {
          id: "action1",
          contactName: "Unknown",
          platform: "gmail",
          type: "new_connection",
        },
      ]);
    });

    it("updates widget with empty array when no actions", () => {
      mockUseQuery.mockReturnValue({ actions: [], nextCursor: null });

      renderHook(() => useActions());

      expect(mockUpdateWidgetActionsList).toHaveBeenCalledWith([]);
    });

    it("updates widget when actions change", () => {
      const initialActions = [{ _id: "action1", contactName: "John", platform: "imessage", type: "message_response" }];
      const newActions = [
        { _id: "action1", contactName: "John", platform: "imessage", type: "message_response" },
        { _id: "action2", contactName: "Jane", platform: "gmail", type: "new_connection" },
      ];

      mockUseQuery.mockReturnValue({ actions: initialActions, nextCursor: null });
      const { rerender } = renderHook(() => useActions());

      expect(mockUpdateWidgetActionsList).toHaveBeenCalledTimes(1);

      // Update actions
      mockUseQuery.mockReturnValue({ actions: newActions, nextCursor: null });
      rerender();

      expect(mockUpdateWidgetActionsList).toHaveBeenCalledTimes(2);
      expect(mockUpdateWidgetActionsList).toHaveBeenLastCalledWith([
        { id: "action1", contactName: "John", platform: "imessage", type: "message_response" },
        { id: "action2", contactName: "Jane", platform: "gmail", type: "new_connection" },
      ]);
    });
  });

  describe("error handling", () => {
    it("returns null error (Convex useQuery throws instead of returning error)", () => {
      mockUseQuery.mockReturnValue({ actions: [], nextCursor: null });

      const { result } = renderHook(() => useActions());

      expect(result.current.error).toBeNull();
    });
  });
});
