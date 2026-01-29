/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as __tests___helpers from "../__tests__/helpers.js";
import type * as actionAnalysis from "../actionAnalysis.js";
import type * as actionEvents from "../actionEvents.js";
import type * as actionQueue from "../actionQueue.js";
import type * as actions from "../actions.js";
import type * as contactResolution from "../contactResolution.js";
import type * as contacts from "../contacts.js";
import type * as crons from "../crons.js";
import type * as debug from "../debug.js";
import type * as embeddings from "../embeddings.js";
import type * as integrations from "../integrations.js";
import type * as lib_actions from "../lib/actions.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_cursors from "../lib/cursors.js";
import type * as memories from "../memories.js";
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
import type * as sync_gmail from "../sync/gmail.js";
import type * as sync_imessage from "../sync/imessage.js";
import type * as sync_linkedin from "../sync/linkedin.js";
import type * as sync_shared from "../sync/shared.js";
import type * as sync_slack from "../sync/slack.js";
import type * as syncCursors from "../syncCursors.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "__tests__/helpers": typeof __tests___helpers;
  actionAnalysis: typeof actionAnalysis;
  actionEvents: typeof actionEvents;
  actionQueue: typeof actionQueue;
  actions: typeof actions;
  contactResolution: typeof contactResolution;
  contacts: typeof contacts;
  crons: typeof crons;
  debug: typeof debug;
  embeddings: typeof embeddings;
  integrations: typeof integrations;
  "lib/actions": typeof lib_actions;
  "lib/auth": typeof lib_auth;
  "lib/cursors": typeof lib_cursors;
  memories: typeof memories;
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
  "sync/gmail": typeof sync_gmail;
  "sync/imessage": typeof sync_imessage;
  "sync/linkedin": typeof sync_linkedin;
  "sync/shared": typeof sync_shared;
  "sync/slack": typeof sync_slack;
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
