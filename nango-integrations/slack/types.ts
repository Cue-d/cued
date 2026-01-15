// Slack API types
// https://api.slack.com/types

/**
 * Represents a Slack conversation (channel, DM, or group DM)
 */
export interface SlackConversation {
    id: string;
    name?: string;
    is_channel: boolean;
    is_group: boolean;
    is_im: boolean;
    is_mpim: boolean;
    is_private: boolean;
    created: number;
    is_archived: boolean;
    is_member: boolean;
    user?: string; // For DMs, the other user's ID
    num_members?: number;
    topic?: {
        value: string;
        creator: string;
        last_set: number;
    };
    purpose?: {
        value: string;
        creator: string;
        last_set: number;
    };
}

/**
 * Represents a Slack message
 */
export interface SlackMessage {
    type: string;
    subtype?: string;
    ts: string; // Timestamp (unique message ID)
    user?: string; // User ID who sent the message
    text: string;
    thread_ts?: string; // Parent thread timestamp (if threaded reply)
    reply_count?: number;
    reply_users_count?: number;
    latest_reply?: string;
    is_starred?: boolean;
    reactions?: SlackReaction[];
    files?: SlackFile[];
    attachments?: SlackAttachment[];
    bot_id?: string; // If sent by a bot
    app_id?: string; // If sent by an app
    edited?: {
        user: string;
        ts: string;
    };
}

/**
 * Represents a reaction on a Slack message
 */
export interface SlackReaction {
    name: string; // Emoji name (without colons)
    count: number;
    users: string[]; // User IDs who reacted
}

/**
 * Represents a file attachment in Slack
 */
export interface SlackFile {
    id: string;
    name: string;
    title?: string;
    mimetype?: string;
    filetype?: string;
    size?: number;
    url_private?: string;
    url_private_download?: string;
    thumb_64?: string;
    thumb_80?: string;
    thumb_160?: string;
}

/**
 * Represents a Slack message attachment (legacy)
 */
export interface SlackAttachment {
    fallback?: string;
    color?: string;
    pretext?: string;
    author_name?: string;
    author_link?: string;
    author_icon?: string;
    title?: string;
    title_link?: string;
    text?: string;
    fields?: Array<{
        title: string;
        value: string;
        short: boolean;
    }>;
    image_url?: string;
    thumb_url?: string;
    footer?: string;
    footer_icon?: string;
    ts?: string;
}

/**
 * Represents a Slack user
 */
export interface SlackUser {
    id: string;
    team_id: string;
    name: string;
    deleted: boolean;
    color?: string;
    real_name?: string;
    tz?: string;
    tz_label?: string;
    tz_offset?: number;
    profile: SlackUserProfile;
    is_admin?: boolean;
    is_owner?: boolean;
    is_primary_owner?: boolean;
    is_restricted?: boolean;
    is_ultra_restricted?: boolean;
    is_bot?: boolean;
    is_app_user?: boolean;
}

/**
 * Represents a Slack user profile
 */
export interface SlackUserProfile {
    title?: string;
    phone?: string;
    skype?: string;
    real_name?: string;
    real_name_normalized?: string;
    display_name?: string;
    display_name_normalized?: string;
    status_text?: string;
    status_emoji?: string;
    status_expiration?: number;
    avatar_hash?: string;
    image_24?: string;
    image_32?: string;
    image_48?: string;
    image_72?: string;
    image_192?: string;
    image_512?: string;
    email?: string;
    first_name?: string;
    last_name?: string;
}

/**
 * Response from conversations.list API
 */
export interface ConversationsListResponse {
    ok: boolean;
    channels: SlackConversation[];
    response_metadata?: {
        next_cursor?: string;
    };
}

/**
 * Response from conversations.history API
 */
export interface ConversationsHistoryResponse {
    ok: boolean;
    messages: SlackMessage[];
    has_more: boolean;
    response_metadata?: {
        next_cursor?: string;
    };
}

/**
 * Response from users.info API
 */
export interface UsersInfoResponse {
    ok: boolean;
    user: SlackUser;
}
