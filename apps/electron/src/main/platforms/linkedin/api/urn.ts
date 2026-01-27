/**
 * URN (Uniform Resource Name) utilities for LinkedIn
 * Ported from mautrix-linkedin Go client
 * Reference: https://github.com/mautrix/linkedin/blob/main/pkg/linkedingo/urn.go
 */

// Regex pattern to parse URN strings: matches "prefix:id" where id can be parenthesized
const URN_PATTERN = /^(.*?):(\(.*\)|[^:]*)$/

/**
 * Represents a LinkedIn URN (Uniform Resource Name).
 * URNs are used throughout LinkedIn's API to identify resources.
 * Format: "prefix:id" (e.g., "urn:li:fsd_profile:ABC123")
 */
export class URN {
  readonly prefix: string
  readonly id: string

  constructor(prefix: string, id: string) {
    this.prefix = prefix
    this.id = id
  }

  /**
   * Parse a URN string into a URN object.
   * @param urn - The URN string to parse (e.g., "urn:li:fsd_profile:ABC123")
   * @returns A URN object, or null if parsing fails
   */
  static parse(urn: string): URN | null {
    if (!urn) {
      return null
    }
    const match = urn.match(URN_PATTERN)
    if (!match) {
      return null
    }
    return new URN(match[1], match[2])
  }

  /**
   * Convert the URN back to its string representation.
   * @returns The URN as a string (e.g., "urn:li:fsd_profile:ABC123")
   */
  toString(): string {
    return `${this.prefix}:${this.id}`
  }

  /**
   * Get the URL-escaped version of the URN string.
   * @returns The URN with special characters percent-encoded
   */
  urlEscaped(): string {
    return encodeURIComponent(this.toString())
  }

  /**
   * Get the nth part of the prefix (colon-separated).
   * @param n - The 0-based index of the prefix part to retrieve
   * @returns The nth prefix part, or empty string if out of bounds
   *
   * @example
   * const urn = URN.parse("urn:li:fsd_profile:ABC123")
   * urn.nthPrefixPart(0) // "urn"
   * urn.nthPrefixPart(1) // "li"
   * urn.nthPrefixPart(2) // "fsd_profile"
   */
  nthPrefixPart(n: number): string {
    const parts = this.prefix.split(':')
    if (n < 0 || n >= parts.length) {
      return ''
    }
    return parts[n]
  }

  /**
   * Create a new URN with a different prefix but the same ID.
   * @param newPrefix - The new prefix to use
   * @returns A new URN with the specified prefix
   */
  withPrefix(newPrefix: string): URN {
    return new URN(newPrefix, this.id)
  }

  /**
   * Convert this URN to an fsd_profile URN format.
   * Used when the ID needs to be referenced as a profile URN.
   * @returns A new URN with "urn:li:fsd_profile" prefix
   *
   * @example
   * const urn = URN.parse("urn:li:member:ABC123")
   * urn.asFsdProfile().toString() // "urn:li:fsd_profile:ABC123"
   */
  asFsdProfile(): URN {
    return new URN('urn:li:fsd_profile', this.id)
  }

  /**
   * Check if the URN is empty (has no ID).
   * @returns True if the ID is empty
   */
  isEmpty(): boolean {
    return this.id === ''
  }

  /**
   * Get just the ID portion of the URN.
   * @returns The ID string
   */
  getId(): string {
    return this.id
  }

  /**
   * Get the full prefix of the URN.
   * @returns The prefix string
   */
  getPrefix(): string {
    return this.prefix
  }

  /**
   * Convert to JSON (serializes as the string representation).
   * @returns The URN as a string for JSON serialization
   */
  toJSON(): string {
    return this.toString()
  }

  /**
   * Create a URN from a JSON value.
   * @param json - The JSON string value
   * @returns A URN object, or null if parsing fails
   */
  static fromJSON(json: string): URN | null {
    return URN.parse(json)
  }
}

/**
 * Type alias for URN string values.
 * Used for type clarity when dealing with raw URN strings.
 */
export type URNString = string

/**
 * Parse a URN string into a URN object.
 * Convenience function that wraps URN.parse().
 * @param urn - The URN string to parse
 * @returns A URN object, or null if parsing fails
 */
export function parseURN(urn: string): URN | null {
  return URN.parse(urn)
}

/**
 * Extract the ID from a URN string without creating a full URN object.
 * @param urn - The URN string
 * @returns The ID portion, or null if parsing fails
 */
export function extractURNId(urn: string): string | null {
  const parsed = URN.parse(urn)
  return parsed ? parsed.id : null
}

/**
 * Check if a string is a valid URN format.
 * @param urn - The string to check
 * @returns True if the string matches URN format
 */
export function isValidURN(urn: string): boolean {
  return URN.parse(urn) !== null
}
