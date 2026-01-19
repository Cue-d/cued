import { describe, expect, it } from 'vitest'
import { URN, parseURN, extractURNId, isValidURN } from '../urn'

describe('URN', () => {
  describe('parse', () => {
    it('parses a simple URN string', () => {
      const urn = URN.parse('urn:li:fsd_profile:ABC123')
      expect(urn).not.toBeNull()
      expect(urn!.prefix).toBe('urn:li:fsd_profile')
      expect(urn!.id).toBe('ABC123')
    })

    it('parses URN with parenthesized ID', () => {
      const urn = URN.parse('urn:li:fsd_conversation:(ABC,DEF)')
      expect(urn).not.toBeNull()
      expect(urn!.prefix).toBe('urn:li:fsd_conversation')
      expect(urn!.id).toBe('(ABC,DEF)')
    })

    it('parses member URN', () => {
      const urn = URN.parse('urn:li:member:123456789')
      expect(urn).not.toBeNull()
      expect(urn!.prefix).toBe('urn:li:member')
      expect(urn!.id).toBe('123456789')
    })

    it('parses message URN', () => {
      const urn = URN.parse('urn:li:messagingMessage:msg123')
      expect(urn).not.toBeNull()
      expect(urn!.prefix).toBe('urn:li:messagingMessage')
      expect(urn!.id).toBe('msg123')
    })

    it('returns null for empty string', () => {
      expect(URN.parse('')).toBeNull()
    })

    it('returns null for null-like input', () => {
      expect(URN.parse(null as unknown as string)).toBeNull()
      expect(URN.parse(undefined as unknown as string)).toBeNull()
    })

    it('returns null for string without colon', () => {
      expect(URN.parse('nocolonhere')).toBeNull()
    })

    it('parses URN with empty ID', () => {
      const urn = URN.parse('urn:li:profile:')
      expect(urn).not.toBeNull()
      expect(urn!.prefix).toBe('urn:li:profile')
      expect(urn!.id).toBe('')
    })
  })

  describe('toString', () => {
    it('reconstructs the original URN string', () => {
      const urn = new URN('urn:li:fsd_profile', 'ABC123')
      expect(urn.toString()).toBe('urn:li:fsd_profile:ABC123')
    })

    it('handles parenthesized IDs', () => {
      const urn = new URN('urn:li:fsd_conversation', '(ABC,DEF)')
      expect(urn.toString()).toBe('urn:li:fsd_conversation:(ABC,DEF)')
    })

    it('round-trips through parse and toString', () => {
      const original = 'urn:li:fsd_profile:XYZ789'
      const urn = URN.parse(original)
      expect(urn!.toString()).toBe(original)
    })
  })

  describe('urlEscaped', () => {
    it('URL-encodes the URN string', () => {
      const urn = new URN('urn:li:fsd_profile', 'ABC123')
      expect(urn.urlEscaped()).toBe('urn%3Ali%3Afsd_profile%3AABC123')
    })

    it('encodes parentheses in ID', () => {
      const urn = new URN('urn:li:fsd_conversation', '(ABC,DEF)')
      expect(urn.urlEscaped()).toBe('urn%3Ali%3Afsd_conversation%3A(ABC%2CDEF)')
    })
  })

  describe('nthPrefixPart', () => {
    it('returns the correct prefix part by index', () => {
      const urn = URN.parse('urn:li:fsd_profile:ABC123')!
      expect(urn.nthPrefixPart(0)).toBe('urn')
      expect(urn.nthPrefixPart(1)).toBe('li')
      expect(urn.nthPrefixPart(2)).toBe('fsd_profile')
    })

    it('returns empty string for out-of-bounds index', () => {
      const urn = URN.parse('urn:li:fsd_profile:ABC123')!
      expect(urn.nthPrefixPart(10)).toBe('')
      expect(urn.nthPrefixPart(-1)).toBe('')
    })

    it('handles single-part prefix', () => {
      const urn = new URN('simple', 'id')
      expect(urn.nthPrefixPart(0)).toBe('simple')
      expect(urn.nthPrefixPart(1)).toBe('')
    })
  })

  describe('withPrefix', () => {
    it('creates a new URN with different prefix', () => {
      const original = URN.parse('urn:li:member:ABC123')!
      const modified = original.withPrefix('urn:li:fsd_profile')
      expect(modified.prefix).toBe('urn:li:fsd_profile')
      expect(modified.id).toBe('ABC123')
      expect(modified.toString()).toBe('urn:li:fsd_profile:ABC123')
    })

    it('does not modify the original URN', () => {
      const original = URN.parse('urn:li:member:ABC123')!
      original.withPrefix('urn:li:fsd_profile')
      expect(original.prefix).toBe('urn:li:member')
    })
  })

  describe('asFsdProfile', () => {
    it('converts URN to fsd_profile format', () => {
      const urn = URN.parse('urn:li:member:ABC123')!
      const profile = urn.asFsdProfile()
      expect(profile.toString()).toBe('urn:li:fsd_profile:ABC123')
    })

    it('works on already-fsd_profile URNs', () => {
      const urn = URN.parse('urn:li:fsd_profile:ABC123')!
      const profile = urn.asFsdProfile()
      expect(profile.toString()).toBe('urn:li:fsd_profile:ABC123')
    })

    it('preserves complex IDs', () => {
      const urn = URN.parse('urn:li:member:(ABC,DEF)')!
      const profile = urn.asFsdProfile()
      expect(profile.toString()).toBe('urn:li:fsd_profile:(ABC,DEF)')
    })
  })

  describe('isEmpty', () => {
    it('returns true for empty ID', () => {
      const urn = new URN('urn:li:profile', '')
      expect(urn.isEmpty()).toBe(true)
    })

    it('returns false for non-empty ID', () => {
      const urn = new URN('urn:li:profile', 'ABC123')
      expect(urn.isEmpty()).toBe(false)
    })
  })

  describe('getId and getPrefix', () => {
    it('returns the ID and prefix', () => {
      const urn = URN.parse('urn:li:fsd_profile:ABC123')!
      expect(urn.getId()).toBe('ABC123')
      expect(urn.getPrefix()).toBe('urn:li:fsd_profile')
    })
  })

  describe('toJSON and fromJSON', () => {
    it('serializes to JSON as string', () => {
      const urn = new URN('urn:li:fsd_profile', 'ABC123')
      expect(urn.toJSON()).toBe('urn:li:fsd_profile:ABC123')
      expect(JSON.stringify(urn)).toBe('"urn:li:fsd_profile:ABC123"')
    })

    it('deserializes from JSON string', () => {
      const urn = URN.fromJSON('urn:li:fsd_profile:ABC123')
      expect(urn).not.toBeNull()
      expect(urn!.prefix).toBe('urn:li:fsd_profile')
      expect(urn!.id).toBe('ABC123')
    })

    it('returns null for invalid JSON input', () => {
      expect(URN.fromJSON('invalid')).toBeNull()
    })
  })
})

describe('parseURN', () => {
  it('is a convenience wrapper for URN.parse', () => {
    const urn = parseURN('urn:li:fsd_profile:ABC123')
    expect(urn).not.toBeNull()
    expect(urn!.prefix).toBe('urn:li:fsd_profile')
    expect(urn!.id).toBe('ABC123')
  })
})

describe('extractURNId', () => {
  it('extracts just the ID from a URN string', () => {
    expect(extractURNId('urn:li:fsd_profile:ABC123')).toBe('ABC123')
  })

  it('returns null for invalid URN', () => {
    expect(extractURNId('invalid')).toBeNull()
  })

  it('handles parenthesized IDs', () => {
    expect(extractURNId('urn:li:fsd_conversation:(ABC,DEF)')).toBe('(ABC,DEF)')
  })
})

describe('isValidURN', () => {
  it('returns true for valid URN strings', () => {
    expect(isValidURN('urn:li:fsd_profile:ABC123')).toBe(true)
    expect(isValidURN('urn:li:member:123')).toBe(true)
    expect(isValidURN('simple:id')).toBe(true)
  })

  it('returns false for invalid URN strings', () => {
    expect(isValidURN('')).toBe(false)
    expect(isValidURN('nocolon')).toBe(false)
  })
})
