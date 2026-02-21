/**
 * Common Slack emoji shortcode → Unicode mappings.
 * Covers the most frequently used reactions.
 * Unknown shortcodes are returned as-is (e.g. `:custom_emoji:`).
 */
const SHORTCODES: Record<string, string> = {
  heart: "❤️",
  thumbsup: "👍",
  "+1": "👍",
  thumbsdown: "👎",
  "-1": "👎",
  joy: "😂",
  fire: "🔥",
  eyes: "👀",
  pray: "🙏",
  raised_hands: "🙌",
  clap: "👏",
  tada: "🎉",
  "100": "💯",
  rocket: "🚀",
  wave: "👋",
  thinking_face: "🤔",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  star: "⭐",
  sparkles: "✨",
  muscle: "💪",
  ok_hand: "👌",
  blue_heart: "💙",
  green_heart: "💚",
  yellow_heart: "💛",
  purple_heart: "💜",
  broken_heart: "💔",
  heart_eyes: "😍",
  sob: "😭",
  rage: "😡",
  skull: "💀",
  sweat_smile: "😅",
  sunglasses: "😎",
  grimacing: "😬",
  rolling_on_the_floor_laughing: "🤣",
  smile: "😄",
  grinning: "😀",
  slightly_smiling_face: "🙂",
  wink: "😉",
  see_no_evil: "🙈",
  party_popper: "🎉",
  gem: "💎",
  bulb: "💡",
  memo: "📝",
  bell: "🔔",
  boom: "💥",
  heavy_plus_sign: "➕",
  hand: "✋",
  point_up: "☝️",
  point_right: "👉",
  raising_hand: "🙋",
  handshake: "🤝",
  heart_hands: "🫶",
  saluting_face: "🫡",
};

/**
 * Convert an emoji shortcode or raw string to a Unicode emoji.
 * Handles formats: `:heart:`, `heart`, or already-Unicode `❤️`.
 */
export function shortcodeToEmoji(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  // Strip surrounding colons if present: `:heart:` → `heart`
  const name =
    trimmed.startsWith(":") && trimmed.endsWith(":") && trimmed.length > 2
      ? trimmed.slice(1, -1)
      : trimmed;

  // Check if it's a known shortcode
  const unicode = SHORTCODES[name];
  if (unicode) return unicode;

  // If the original input had colons and we didn't find a match,
  // return the shortcode as-is (custom emoji)
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) return trimmed;

  // Otherwise it's likely already a Unicode emoji
  return trimmed;
}
