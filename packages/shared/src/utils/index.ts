/**
 * Shared utility functions for PRM
 */

/**
 * Get initials from a name, handling phone numbers and emails.
 *
 * @param name - The name, email, or phone number to extract initials from
 * @returns Up to 2 uppercase initials, "#" for phone numbers, or first char for emails
 *
 * @example
 * getInitials("John Doe") // "JD"
 * getInitials("Alice") // "A"
 * getInitials("+1234567890") // "#"
 * getInitials("user@example.com") // "U"
 */
export function getInitials(name: string): string {
  // Phone numbers (starting with + or digit)
  if (/^\+?\d/.test(name)) return "#";

  // Email addresses
  if (name.includes("@")) return name[0]?.toUpperCase() ?? "?";

  // Regular names - take first letter of each word, max 2
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Truncate text to a maximum length, adding ellipsis if needed.
 *
 * @param text - The text to truncate
 * @param maxLength - Maximum length including ellipsis
 * @returns Truncated text with "..." if it exceeded maxLength
 *
 * @example
 * truncate("Hello World", 8) // "Hello..."
 * truncate("Hi", 8) // "Hi"
 */
export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength - 3) + "...";
}
