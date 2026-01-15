/**
 * Chat priority calculation for LLM analysis queue.
 *
 * Priority scoring for LLM analysis queue (0-100 scale, higher = processed sooner).
 * Uses a time-decay curve and contact importance signals.
 */

/** Contact information for priority calculation */
export interface ContactPriorityInfo {
  isContact?: boolean;
  company?: string | null;
  notes?: string | null;
}

/**
 * Calculate priority based on time since last message using a curve.
 *
 * The "Goldilocks zone" is 2-72 hours:
 * - 0-2 hours: Low priority (still in active conversation, don't interrupt)
 * - 2-24 hours: Ramping up (conversation cooling, may need follow-up)
 * - 24-72 hours: Peak priority (definitely needs attention)
 * - 72-168 hours (3-7 days): Declining (getting stale)
 * - 168+ hours: Low priority (probably too late to matter much)
 *
 * @returns priority component (20-80)
 */
export function calculateTimePriority(hoursSince: number): number {
  if (hoursSince < 2) {
    return 20; // Too fresh
  }
  if (hoursSince < 24) {
    // Ramp from 40 to 70 over 22 hours
    return Math.floor(40 + (hoursSince - 2) * (30 / 22));
  }
  if (hoursSince < 72) {
    return 80; // Peak urgency zone
  }
  if (hoursSince < 168) {
    // Decay from 80 to 40 over 96 hours
    return Math.floor(80 - (hoursSince - 72) * (40 / 96));
  }
  return 30; // Very old, low priority
}

/**
 * Calculate priority boost based on contact importance.
 *
 * Saved contacts with metadata are likely more important relationships.
 *
 * @returns priority boost (0-25)
 */
export function calculateContactBoost(contact?: ContactPriorityInfo | null): number {
  if (!contact) return 0;

  let boost = 0;

  // Saved contacts are more important than unknown numbers
  if (contact.isContact) {
    boost += 10;
  }

  // Company field suggests professional relationship
  if (contact.company) {
    boost += 10;
  }

  // Notes suggest you've documented this relationship
  if (contact.notes) {
    boost += 5;
  }

  return boost;
}

/**
 * Calculate priority penalty for group chats.
 *
 * Group chats are often less actionable - someone else may respond.
 *
 * @returns penalty (negative value, -15 for groups)
 */
export function calculateGroupPenalty(isGroup: boolean): number {
  return isGroup ? -15 : 0;
}

export interface CalculatePriorityInput {
  hoursSince: number;
  contact?: ContactPriorityInfo | null;
  isGroup?: boolean;
}

/**
 * Calculate overall priority score for a chat's LLM analysis.
 *
 * Combines:
 * - Time-decay curve (base priority)
 * - Contact importance boost
 * - Group chat penalty
 *
 * @returns priority score (10-100)
 */
export function calculatePriority(input: CalculatePriorityInput): number {
  const { hoursSince, contact, isGroup = false } = input;

  // Base priority from time curve (20-80)
  let priority = calculateTimePriority(hoursSince);

  // Add contact importance boost (0-25)
  priority += calculateContactBoost(contact);

  // Apply group penalty (-15 or 0)
  priority += calculateGroupPenalty(isGroup);

  // Clamp to valid range
  return Math.max(10, Math.min(100, priority));
}
