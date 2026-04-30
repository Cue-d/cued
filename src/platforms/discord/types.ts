export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
  bot?: boolean;
}

export interface DiscordChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string | null;
  topic?: string | null;
  parent_id?: string | null;
  owner_id?: string | null;
  recipients?: DiscordUser[];
  last_message_id?: string | null;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string | null;
  size?: number;
  url?: string;
  proxy_url?: string;
  width?: number | null;
  height?: number | null;
}

export interface DiscordMessageReference {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
}

export interface DiscordMember {
  nick?: string | null;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  member?: DiscordMember;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  attachments?: DiscordAttachment[];
  message_reference?: DiscordMessageReference;
}

export interface DiscordStoredCredentials {
  token: string;
  savedAt: number;
  userId: string;
  username: string;
  globalName?: string | null;
}

export const DISCORD_DM_CHANNEL_TYPES = new Set([1, 3]);

export function isDiscordDmChannel(channel: Pick<DiscordChannel, "type">): boolean {
  return DISCORD_DM_CHANNEL_TYPES.has(channel.type);
}

export function discordSourceKey(userId: string): string {
  return `discord:${userId}`;
}

export function discordConversationSourceKey(channelId: string): string {
  return `discord:channel:${channelId}`;
}

export function discordMessageSourceKey(channelId: string, messageId: string): string {
  return `discord:message:${channelId}:${messageId}`;
}

export function discordDisplayName(user: Pick<DiscordUser, "global_name" | "username">): string {
  return user.global_name?.trim() || user.username;
}

export function discordAvatarUrl(
  user: Pick<DiscordUser, "id" | "avatar">,
  size = 256,
): string | null {
  if (!user.avatar) {
    return null;
  }
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=${size}`;
}
