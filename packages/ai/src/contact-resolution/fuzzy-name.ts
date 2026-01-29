/**
 * Fuzzy name matching for contact resolution.
 * Task 6.0b: Match contacts by similar names using Jaro-Winkler + nicknames.
 */

import { CONFIDENCE, JARO_WINKLER } from "./thresholds";

/**
 * Common nickname mappings.
 * Maps nicknames to their canonical full names.
 */
const NICKNAME_MAP: Record<string, string> = {
  // Male names
  bob: "robert",
  bobby: "robert",
  rob: "robert",
  robbie: "robert",
  mike: "michael",
  mikey: "michael",
  mick: "michael",
  bill: "william",
  billy: "william",
  will: "william",
  willy: "william",
  liam: "william",
  jim: "james",
  jimmy: "james",
  jamie: "james",
  joe: "joseph",
  joey: "joseph",
  jo: "joseph",
  tom: "thomas",
  tommy: "thomas",
  dick: "richard",
  rick: "richard",
  ricky: "richard",
  rich: "richard",
  dave: "david",
  davey: "david",
  dan: "daniel",
  danny: "daniel",
  tony: "anthony",
  steve: "steven",
  stevie: "steven",
  chris: "christopher",
  matt: "matthew",
  matty: "matthew",
  nick: "nicholas",
  nicky: "nicholas",
  ed: "edward",
  eddie: "edward",
  ted: "edward",
  teddy: "edward",
  andy: "andrew",
  drew: "andrew",
  pete: "peter",
  petey: "peter",
  alex: "alexander",
  al: "albert",
  bert: "albert",
  charlie: "charles",
  chuck: "charles",
  greg: "gregory",
  jeff: "jeffrey",
  geoff: "geoffrey",
  jon: "jonathan",
  johnny: "john",
  jack: "john",
  larry: "lawrence",
  len: "leonard",
  lenny: "leonard",
  ken: "kenneth",
  kenny: "kenneth",
  ron: "ronald",
  ronnie: "ronald",
  sam: "samuel",
  sammy: "samuel",
  ben: "benjamin",
  benny: "benjamin",
  pat: "patrick",
  paddy: "patrick",
  phil: "philip",
  ray: "raymond",
  walt: "walter",
  wally: "walter",
  // Female names
  kate: "katherine",
  katie: "katherine",
  kathy: "katherine",
  cathy: "catherine",
  liz: "elizabeth",
  lizzy: "elizabeth",
  beth: "elizabeth",
  betty: "elizabeth",
  sue: "susan",
  susie: "susan",
  suzy: "susan",
  jen: "jennifer",
  jenny: "jennifer",
  jenn: "jennifer",
  meg: "margaret",
  maggie: "margaret",
  peggy: "margaret",
  marge: "margaret",
  pam: "pamela",
  patty: "patricia",
  trish: "patricia",
  barb: "barbara",
  babs: "barbara",
  deb: "deborah",
  debbie: "deborah",
  chrissy: "christine",
  tina: "christina",
  nancy: "ann",
  annie: "ann",
  anna: "ann",
  vicky: "victoria",
  vikki: "victoria",
  mandy: "amanda",
  cindy: "cynthia",
  abby: "abigail",
  gail: "abigail",
  becky: "rebecca",
  becca: "rebecca",
  // Gender-neutral (already covered above: chris, alex, sam, pat, tony, terry)
  terry: "terrence",
};

/**
 * Get the canonical name for a nickname.
 * Returns the input if no mapping found.
 */
function getCanonicalName(name: string): string {
  const lower = name.toLowerCase().trim();
  return NICKNAME_MAP[lower] || lower;
}

/**
 * Normalize a name for comparison.
 * - Lowercase
 * - Remove titles (Dr., Mr., Mrs., Ms., Prof., etc.)
 * - Trim whitespace
 * - Normalize whitespace
 */
export function normalizeName(name: string): string {
  let normalized = name.toLowerCase().trim();

  // Remove common titles (order matters - check longer patterns first)
  const titlesWithDot = ["dr.", "mr.", "mrs.", "ms.", "prof.", "jr.", "sr."];
  const titlesWithoutDot = [
    "dr",
    "mr",
    "mrs",
    "ms",
    "prof",
    "jr",
    "sr",
    "sir",
    "dame",
    "iii",
    "ii",
    "iv",
  ];

  // First remove titles with dots (escape the dot in regex)
  for (const title of titlesWithDot) {
    const escaped = title.replace(".", "\\.");
    const regex = new RegExp(`\\b${escaped}`, "gi");
    normalized = normalized.replace(regex, "");
  }

  // Then remove titles without dots (word boundaries)
  for (const title of titlesWithoutDot) {
    const regex = new RegExp(`\\b${title}\\b`, "gi");
    normalized = normalized.replace(regex, "");
  }

  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

/**
 * Split a name into parts (first, middle, last).
 */
function splitName(name: string): string[] {
  return normalizeName(name).split(" ").filter(Boolean);
}

/**
 * Get canonical name parts for a name.
 */
function getCanonicalParts(name: string): string[] {
  return splitName(name).map(getCanonicalName);
}

/**
 * Calculate Jaro similarity between two strings.
 * Returns value between 0 (no match) and 1 (exact match).
 */
function jaroSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches) /
    3
  );
}

/**
 * Calculate Jaro-Winkler similarity between two strings.
 * Gives more weight to strings that match from the beginning.
 * Returns value between 0 (no match) and 1 (exact match).
 */
export function jaroWinklerSimilarity(s1: string, s2: string): number {
  const jaro = jaroSimilarity(s1, s2);

  // Count common prefix (up to 4 characters)
  let prefixLength = 0;
  const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  // Winkler modification
  return jaro + prefixLength * JARO_WINKLER.SCALING_FACTOR * (1 - jaro);
}

/**
 * Calculate name similarity score between two names.
 * Uses Jaro-Winkler with nickname normalization.
 *
 * IMPORTANT: Requires BOTH first and last names to be somewhat similar.
 * Sharing only a last name (e.g., "Brandon Zhu" vs "Elise Zhu") is NOT enough.
 *
 * @returns Score from 0 to 1
 */
export function nameSimilarity(name1: string, name2: string): number {
  const parts1 = getCanonicalParts(name1);
  const parts2 = getCanonicalParts(name2);

  if (parts1.length === 0 || parts2.length === 0) return 0;

  // Exact match after normalization
  if (parts1.join(" ") === parts2.join(" ")) return 1;

  // Handle "F. Last" or "F Last" format (initial + last name) FIRST
  // This prevents false negatives like "J. Smith" vs "John Smith"
  // Check for single letter or single letter with period
  const isInitial = (s: string) =>
    s.length === 1 || (s.length === 2 && s.endsWith("."));
  const getInitialLetter = (s: string) => s.replace(".", "")[0];

  const hasInitial =
    (parts1.length >= 2 && isInitial(parts1[0])) ||
    (parts2.length >= 2 && isInitial(parts2[0]));

  if (hasInitial) {
    const [short, long] = isInitial(parts1[0])
      ? [parts1, parts2]
      : [parts2, parts1];
    if (short.length >= 2 && long.length >= 1) {
      const initial = getInitialLetter(short[0]);
      const shortLast = short[short.length - 1];
      const longFirst = long[0];
      const longLast = long[long.length - 1];

      // Check if initial matches first letter of full first name
      if (longFirst.startsWith(initial)) {
        const lastMatchScore = jaroWinklerSimilarity(shortLast, longLast);
        // If last names match well, this is likely the same person
        if (lastMatchScore >= CONFIDENCE.MEDIUM) {
          return 0.3 + lastMatchScore * 0.7; // Returns ~0.86-1.0 for good matches
        }
      }
    }
  }

  // Extract first and last names
  const first1 = parts1[0];
  const last1 = parts1.length > 1 ? parts1[parts1.length - 1] : first1;
  const first2 = parts2[0];
  const last2 = parts2.length > 1 ? parts2[parts2.length - 1] : first2;

  const firstScore = jaroWinklerSimilarity(first1, first2);
  const lastScore = jaroWinklerSimilarity(last1, last2);

  // CRITICAL: Detect "same last name, completely different first name" pattern
  // This catches false positives like "Brandon Zhu" vs "Elise Zhu"
  const lastNamesMatch = lastScore >= CONFIDENCE.HIGH;
  const firstNamesVeryDifferent = firstScore <= CONFIDENCE.LOW;

  if (lastNamesMatch && firstNamesVeryDifferent) {
    // Same last name but different first name = different person
    return Math.min(CONFIDENCE.REJECTION_CAP, firstScore);
  }

  // Same pattern for first names matching but last names different
  // e.g., "John Smith" shouldn't match "John Jones"
  const firstNamesMatch = firstScore >= CONFIDENCE.HIGH;
  const lastNamesVeryDifferent = lastScore <= CONFIDENCE.LOW;

  if (firstNamesMatch && lastNamesVeryDifferent) {
    // Same first name, very different last name = likely different person
    return Math.min(CONFIDENCE.REJECTION_CAP, lastScore);
  }

  // Strategy 1: Full name comparison
  const fullScore = jaroWinklerSimilarity(parts1.join(" "), parts2.join(" "));

  // Strategy 2: First + Last name comparison (ignore middle names)
  // Weight equally - both must be similar for a good match
  const firstLastScore = firstScore * 0.5 + lastScore * 0.5;

  // Return the highest score from all strategies
  return Math.max(fullScore, firstLastScore);
}

/**
 * Check if two names likely refer to the same person.
 *
 * @param name1 First name
 * @param name2 Second name
 * @param threshold Minimum similarity score (default CONFIDENCE.MEDIUM)
 * @returns Whether names match above threshold
 */
export function namesMatch(
  name1: string,
  name2: string,
  threshold: number = CONFIDENCE.MEDIUM,
): boolean {
  return nameSimilarity(name1, name2) >= threshold;
}

/**
 * Result of fuzzy name matching.
 */
export interface NameMatchResult {
  matches: boolean;
  confidence: number;
  normalizedName1: string;
  normalizedName2: string;
}

/**
 * Get detailed name match result.
 */
export function getNameMatchResult(
  name1: string,
  name2: string,
): NameMatchResult {
  const confidence = nameSimilarity(name1, name2);

  return {
    matches: confidence >= CONFIDENCE.MEDIUM,
    confidence,
    normalizedName1: getCanonicalParts(name1).join(" "),
    normalizedName2: getCanonicalParts(name2).join(" "),
  };
}

