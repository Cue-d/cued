/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actionAnalysis from "../actionAnalysis.js";
import type * as actionEvents from "../actionEvents.js";
import type * as actionQueue from "../actionQueue.js";
import type * as actions from "../actions.js";
import type * as contactResolution from "../contactResolution.js";
import type * as contacts from "../contacts.js";
import type * as crons from "../crons.js";
import type * as debug from "../debug.js";
import type * as embeddings from "../embeddings.js";
import type * as http from "../http.js";
import type * as integrations from "../integrations.js";
import type * as lib_actionSummary from "../lib/actionSummary.js";
import type * as lib_actions from "../lib/actions.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_avatar from "../lib/avatar.js";
import type * as lib_contactMerge from "../lib/contactMerge.js";
import type * as lib_contactMergeScheduling from "../lib/contactMergeScheduling.js";
import type * as lib_contactStatus from "../lib/contactStatus.js";
import type * as lib_cursors from "../lib/cursors.js";
import type * as lib_emoji from "../lib/emoji.js";
import type * as lib_mergeResolution from "../lib/mergeResolution.js";
import type * as lib_normalizeHandle from "../lib/normalizeHandle.js";
import type * as lib_queueMerge from "../lib/queueMerge.js";
import type * as lib_queueMessageInsert from "../lib/queueMessageInsert.js";
import type * as lib_reactions from "../lib/reactions.js";
import type * as messageQueue from "../messageQueue.js";
import type * as messages from "../messages.js";
import type * as presence from "../presence.js";
import type * as reset from "../reset.js";
import type * as search from "../search.js";
import type * as swipeHandlers_eodContact from "../swipeHandlers/eodContact.js";
import type * as swipeHandlers_message from "../swipeHandlers/message.js";
import type * as swipeHandlers_newConnection from "../swipeHandlers/newConnection.js";
import type * as swipeHandlers_registry from "../swipeHandlers/registry.js";
import type * as swipeHandlers_resolveContact from "../swipeHandlers/resolveContact.js";
import type * as swipeHandlers_types from "../swipeHandlers/types.js";
import type * as sync from "../sync.js";
import type * as sync_batchUtils from "../sync/batchUtils.js";
import type * as sync_imessage from "../sync/imessage.js";
import type * as sync_linkedin from "../sync/linkedin.js";
import type * as sync_shared from "../sync/shared.js";
import type * as sync_signal from "../sync/signal.js";
import type * as sync_slack from "../sync/slack.js";
import type * as sync_twitter from "../sync/twitter.js";
import type * as syncCursors from "../syncCursors.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actionAnalysis: typeof actionAnalysis;
  actionEvents: typeof actionEvents;
  actionQueue: typeof actionQueue;
  actions: typeof actions;
  contactResolution: typeof contactResolution;
  contacts: typeof contacts;
  crons: typeof crons;
  debug: typeof debug;
  embeddings: typeof embeddings;
  http: typeof http;
  integrations: typeof integrations;
  "lib/actionSummary": typeof lib_actionSummary;
  "lib/actions": typeof lib_actions;
  "lib/auth": typeof lib_auth;
  "lib/avatar": typeof lib_avatar;
  "lib/contactMerge": typeof lib_contactMerge;
  "lib/contactMergeScheduling": typeof lib_contactMergeScheduling;
  "lib/contactStatus": typeof lib_contactStatus;
  "lib/cursors": typeof lib_cursors;
  "lib/emoji": typeof lib_emoji;
  "lib/mergeResolution": typeof lib_mergeResolution;
  "lib/normalizeHandle": typeof lib_normalizeHandle;
  "lib/queueMerge": typeof lib_queueMerge;
  "lib/queueMessageInsert": typeof lib_queueMessageInsert;
  "lib/reactions": typeof lib_reactions;
  messageQueue: typeof messageQueue;
  messages: typeof messages;
  presence: typeof presence;
  reset: typeof reset;
  search: typeof search;
  "swipeHandlers/eodContact": typeof swipeHandlers_eodContact;
  "swipeHandlers/message": typeof swipeHandlers_message;
  "swipeHandlers/newConnection": typeof swipeHandlers_newConnection;
  "swipeHandlers/registry": typeof swipeHandlers_registry;
  "swipeHandlers/resolveContact": typeof swipeHandlers_resolveContact;
  "swipeHandlers/types": typeof swipeHandlers_types;
  sync: typeof sync;
  "sync/batchUtils": typeof sync_batchUtils;
  "sync/imessage": typeof sync_imessage;
  "sync/linkedin": typeof sync_linkedin;
  "sync/shared": typeof sync_shared;
  "sync/signal": typeof sync_signal;
  "sync/slack": typeof sync_slack;
  "sync/twitter": typeof sync_twitter;
  syncCursors: typeof syncCursors;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
