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
