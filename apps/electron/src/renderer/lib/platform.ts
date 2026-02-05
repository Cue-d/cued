/**
 * Platform detection utilities for the renderer process.
 */

export function getIsMac(): boolean {
  if (typeof navigator !== "undefined") {
    return navigator.platform.toLowerCase().includes("mac");
  }
  return process.platform === "darwin";
}

export const isMac: boolean = getIsMac();

export const cmdKey: string = isMac ? "⌘" : "Ctrl";
