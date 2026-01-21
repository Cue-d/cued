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
import type * as debug_cleanupDuplicateHandles from "../debug/cleanupDuplicateHandles.js";
import type * as debug_findDuplicateHandles from "../debug/findDuplicateHandles.js";
import type * as files from "../files.js";
import type * as integrations from "../integrations.js";
import type * as lib_auth from "../lib/auth.js";
import type * as memories from "../memories.js";
import type * as messageQueue from "../messageQueue.js";
import type * as messages from "../messages.js";
import type * as presence from "../presence.js";
import type * as reset from "../reset.js";
import type * as search from "../search.js";
import type * as sync from "../sync.js";
import type * as sync_gmail from "../sync/gmail.js";
import type * as sync_imessage from "../sync/imessage.js";
import type * as sync_linkedin from "../sync/linkedin.js";
import type * as sync_shared from "../sync/shared.js";
import type * as sync_slack from "../sync/slack.js";
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
  "debug/cleanupDuplicateHandles": typeof debug_cleanupDuplicateHandles;
  "debug/findDuplicateHandles": typeof debug_findDuplicateHandles;
  files: typeof files;
  integrations: typeof integrations;
  "lib/auth": typeof lib_auth;
  memories: typeof memories;
  messageQueue: typeof messageQueue;
  messages: typeof messages;
  presence: typeof presence;
  reset: typeof reset;
  search: typeof search;
  sync: typeof sync;
  "sync/gmail": typeof sync_gmail;
  "sync/imessage": typeof sync_imessage;
  "sync/linkedin": typeof sync_linkedin;
  "sync/shared": typeof sync_shared;
  "sync/slack": typeof sync_slack;
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
