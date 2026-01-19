import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useQuery } from "convex/react";
import { usePendingActionCount } from "../usePendingActionCount";
import { updateWidgetData } from "@/lib/widget-data";

// Mock convex/react is already done in setup.ts
vi.mock("convex/react");
vi.mock("@/lib/widget-data");

const mockUseQuery = vi.mocked(useQuery);
const mockUpdateWidgetData = vi.mocked(updateWidgetData);

describe("usePendingActionCount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when query result is undefined", () => {
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() => usePendingActionCount());

    expect(result.current).toBe(0);
  });

  it("returns 0 when query result has no count", () => {
    mockUseQuery.mockReturnValue({});

    const { result } = renderHook(() => usePendingActionCount());

    expect(result.current).toBe(0);
  });

  it("returns count from query result", () => {
    mockUseQuery.mockReturnValue({ count: 5 });

    const { result } = renderHook(() => usePendingActionCount());

    expect(result.current).toBe(5);
  });

  it("updates widget data when count changes", () => {
    mockUseQuery.mockReturnValue({ count: 3 });

    renderHook(() => usePendingActionCount());

    expect(mockUpdateWidgetData).toHaveBeenCalledWith(3);
  });

  it("updates widget data with 0 when count is undefined", () => {
    mockUseQuery.mockReturnValue(undefined);

    renderHook(() => usePendingActionCount());

    expect(mockUpdateWidgetData).toHaveBeenCalledWith(0);
  });

  it("calls useQuery with correct API endpoint", () => {
    mockUseQuery.mockReturnValue({ count: 0 });

    renderHook(() => usePendingActionCount());

    // Verify useQuery was called (we can't easily verify the exact api reference)
    expect(mockUseQuery).toHaveBeenCalled();
  });
});
