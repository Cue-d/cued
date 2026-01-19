/**
 * Time formatting utilities for PRM
 */

/**
 * Format a timestamp as a localized time string (e.g., "3:45 PM").
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted time string
 *
 * @example
 * formatTime(1705600000000) // "3:45 PM" (varies by locale)
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Format a timestamp as a relative time string (e.g., "5m ago", "2h ago").
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Relative time string
 *
 * @example
 * formatRelativeTime(Date.now() - 30000) // "just now"
 * formatRelativeTime(Date.now() - 300000) // "5m ago"
 * formatRelativeTime(Date.now() - 7200000) // "2h ago"
 * formatRelativeTime(Date.now() - 172800000) // "2d ago"
 * formatRelativeTime(Date.now() - 864000000) // "1/5/2026" (>7 days)
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Options for formatTimestamp
 */
export interface FormatTimestampOptions {
  /**
   * Style of formatting
   * - "time": Just the time (e.g., "3:45 PM")
   * - "relative": Relative time (e.g., "5m ago")
   * - "smart": Smart formatting based on how recent (time for today, "Yesterday", weekday for <7 days, date otherwise)
   * @default "smart"
   */
  style?: "time" | "relative" | "smart";
}

/**
 * Format a timestamp with configurable options.
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @param options - Formatting options
 * @returns Formatted time string
 *
 * @example
 * // Default "smart" style
 * formatTimestamp(todayTimestamp) // "3:45 PM"
 * formatTimestamp(yesterdayTimestamp) // "Yesterday"
 * formatTimestamp(threeDaysAgoTimestamp) // "Mon"
 * formatTimestamp(twoWeeksAgoTimestamp) // "Jan 5"
 *
 * // Explicit styles
 * formatTimestamp(timestamp, { style: "time" }) // "3:45 PM"
 * formatTimestamp(timestamp, { style: "relative" }) // "2h ago"
 */
export function formatTimestamp(
  timestamp: number,
  options: FormatTimestampOptions = {}
): string {
  const { style = "smart" } = options;

  if (style === "time") {
    return formatTime(timestamp);
  }

  if (style === "relative") {
    return formatRelativeTime(timestamp);
  }

  // Smart formatting
  const date = new Date(timestamp);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - timestamp) / (1000 * 60 * 60 * 24));

  // Today: show time
  if (diffDays === 0 && date.getDate() === now.getDate()) {
    return formatTime(timestamp);
  }

  // Yesterday
  if (diffDays === 1 || (diffDays === 0 && date.getDate() !== now.getDate())) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.getDate() === yesterday.getDate()) {
      return "Yesterday";
    }
  }

  // Within last 7 days: show weekday
  if (diffDays < 7) {
    return date.toLocaleDateString("en-US", { weekday: "short" });
  }

  // Older: show month and day
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
