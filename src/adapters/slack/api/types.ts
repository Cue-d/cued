export interface SlackCredentials {
  token: string;
  cookie: string;
}

export interface SlackAuthTestResponse {
  ok: boolean;
  error?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
}

export interface SlackUserProfile {
  real_name?: string;
  display_name?: string;
  email?: string;
  image_72?: string;
  image_192?: string;
  image_512?: string;
  image_original?: string;
}

export interface SlackUser {
  id: string;
  team_id: string;
  name: string;
  real_name?: string;
  deleted?: boolean;
  profile: SlackUserProfile;
}

export interface SlackUsersListResponse {
  ok: boolean;
  error?: string;
  members?: SlackUser[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype?: string;
  pretty_type?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  thumb_360?: string;
  thumb_480?: string;
}

export interface SlackAttachment {
  fallback?: string;
  text?: string;
  title?: string;
  title_link?: string;
  image_url?: string;
  thumb_url?: string;
  footer?: string;
  ts?: string | number;
}

export interface SlackMessage {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: SlackReaction[];
  attachments?: SlackAttachment[];
  files?: SlackFile[];
  edited?: { user: string; ts: string };
}

export interface SlackConversation {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  user?: string;
  topic?: { value: string };
  purpose?: { value: string };
  latest?: SlackMessage;
}

export interface SlackConversationsListResponse {
  ok: boolean;
  error?: string;
  channels?: SlackConversation[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackConversationsHistoryResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackConversationsRepliesResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackConversationsMembersResponse {
  ok: boolean;
  error?: string;
  members?: string[];
  response_metadata?: { next_cursor?: string };
}
