/**
 * Mock for expo-widgets module
 * Provides stub implementations for iOS widget functionality
 */
import { vi } from "vitest";
import type React from "react";

export const updateWidgetSnapshot = vi.fn();
export const updateWidgetTimeline = vi.fn();
export const startLiveActivity = vi.fn().mockReturnValue("mock-activity-id");
export const updateLiveActivity = vi.fn();
export const addUserInteractionListener = vi.fn(() => ({ remove: vi.fn() }));

// Type exports for compatibility
export type WidgetFamily =
  | "systemSmall"
  | "systemMedium"
  | "systemLarge"
  | "systemExtraLarge"
  | "accessoryCircular"
  | "accessoryRectangular"
  | "accessoryInline";

export interface WidgetBase<T extends object = object> {
  date: Date;
  family: WidgetFamily;
  props: T;
}

export type LiveActivityComponent = () => React.JSX.Element;

export interface UserInteractionEvent {
  widgetName: string;
  action: string;
  parameters?: Record<string, unknown>;
}

export interface ExpoWidgetsEvents {
  onUserInteraction: (event: UserInteractionEvent) => void;
}

export type ExpoLiveActivityEntry = object;
