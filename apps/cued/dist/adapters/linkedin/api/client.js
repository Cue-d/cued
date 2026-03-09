import { COOKIE_NAMES, DEFAULT_X_LI_TRACK, USER_AGENT } from "./constants.js";
import { getConnections } from "./contacts.js";
import { getConversations, getConversationsBefore } from "./conversations.js";
import { linkedInEncode, newGetRequest } from "./request.js";
export class LinkedInClient {
    _cookies;
    _userAgent;
    _xLiTrack;
    _userEntityURN = null;
    constructor(options = {}) {
        this._cookies = options.cookies ?? [];
        this._userAgent = options.userAgent ?? USER_AGENT;
        this._xLiTrack = options.xLiTrack ?? DEFAULT_X_LI_TRACK;
    }
    get cookies() {
        return this._cookies;
    }
    get userEntityURN() {
        return this._userEntityURN;
    }
    get userAgent() {
        return this._userAgent;
    }
    get xLiTrack() {
        return this._xLiTrack;
    }
    isAuthenticated() {
        return this._cookies.some((cookie) => cookie.name === COOKIE_NAMES.authToken && cookie.value)
            && this._cookies.some((cookie) => cookie.name === COOKIE_NAMES.sessionId && cookie.value);
    }
    async fetchSelf() {
        if (this._userEntityURN) {
            return this._userEntityURN;
        }
        const response = await newGetRequest("https://www.linkedin.com/voyager/api/me", this._cookies)
            .withXLIHeaders()
            .doJSON();
        const miniProfile = response.included?.find((item) => item.$type?.includes("MiniProfile") || item.entityUrn?.includes("fsd_profile"));
        const urn = miniProfile?.entityUrn;
        if (urn) {
            const match = urn.match(/:([^:]+)$/);
            if (match?.[1]) {
                this._userEntityURN = `urn:li:fsd_profile:${match[1]}`;
                return this._userEntityURN;
            }
        }
        if (response.data?.plainId) {
            this._userEntityURN = `urn:li:fsd_profile:${response.data.plainId}`;
            return this._userEntityURN;
        }
        throw new Error("Could not determine user entity URN from /me response");
    }
    async getMailboxUrn() {
        return linkedInEncode(await this.fetchSelf());
    }
    async getConversations(syncToken) {
        return getConversations(this, syncToken);
    }
    async getConversationsBefore(timestamp) {
        return getConversationsBefore(this, timestamp);
    }
    async getMessages(conversationId) {
        const { getMessages } = await import("./messages.js");
        return getMessages(this, conversationId);
    }
    async getMessagesBefore(conversationId, timestamp) {
        const { getMessagesBefore } = await import("./messages.js");
        return getMessagesBefore(this, conversationId, timestamp);
    }
    async getConnections(cursor) {
        return getConnections(this, cursor);
    }
}
//# sourceMappingURL=client.js.map