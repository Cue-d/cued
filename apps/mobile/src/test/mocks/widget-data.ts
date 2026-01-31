/**
 * Mock for @/lib/widget-data module
 * Prevents expo-widgets from being loaded in tests
 */
import { vi } from "vitest";

export interface WidgetAction {
  id: string;
  contactName: string;
  platform: string | null;
  type: string;
}

export const updateWidgetData = vi.fn();
export const updateWidgetActionsList = vi.fn();
