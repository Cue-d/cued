/**
 * Reactive ConvexClient singleton for Electron.
 * Provides WebSocket-based subscriptions for real-time query updates.
 *
 * Unlike ConvexHttpClient (used for one-shot requests), this client maintains
 * a persistent WebSocket connection for reactive queries.
 */
import { ConvexClient } from "convex/browser";
import type {
  FunctionReference,
  FunctionArgs,
  FunctionReturnType,
} from "convex/server";
import { electronEnv } from "@prm/env/electron";

const CONVEX_URL = electronEnv.CONVEX_URL;

/**
 * Unsubscribe handle returned by subscribe().
 * Can be called as a function or via .unsubscribe() method.
 */
export type Unsubscribe<T> = {
  /** Stop receiving updates */
  (): void;
  /** Stop receiving updates */
  unsubscribe(): void;
  /** Get the current value (may be undefined if not yet loaded) */
  getCurrentValue(): T | undefined;
};

type TokenProvider = (forceRefresh?: boolean) => Promise<string | null>;

export interface ReactiveConvexClientOptions {
  /** Function to get a valid auth token (should handle refresh internally) */
  getAuthToken?: TokenProvider;
  /** Called when auth becomes invalid and cannot be refreshed */
  onAuthInvalid?: () => void;
}

/**
 * Singleton wrapper around ConvexClient providing:
 * - Auth token management with automatic refresh
 * - Type-safe subscribe() helper for reactive queries
 * - Type-safe mutation() helper for mutations
 */
class ReactiveConvexClient {
  private client: ConvexClient;
  private tokenProvider: TokenProvider | null = null;
  private onAuthInvalid: (() => void) | null = null;
  private isAuthenticated = false;

  constructor() {
    this.client = new ConvexClient(CONVEX_URL);
  }

  /**
   * Configure the auth token provider.
   * The provider should return a valid token or null if unavailable.
   */
  setTokenProvider(provider: TokenProvider): void {
    this.tokenProvider = provider;
    this.setupAuth();
  }

  /**
   * Set callback for when authentication fails and cannot be recovered.
   */
  setAuthInvalidCallback(callback: () => void): void {
    this.onAuthInvalid = callback;
  }

  /**
   * Set up authentication with auto-refresh.
   * ConvexClient handles token expiry and calls fetchToken again.
   */
  private setupAuth(): void {
    if (!this.tokenProvider) return;

    this.client.setAuth(
      async () => {
        const token = await this.tokenProvider?.();
        if (!token) {
          console.warn("[ReactiveConvexClient] Token provider returned null");
          return null;
        }
        return token;
      },
      (isAuth) => {
        const wasAuthenticated = this.isAuthenticated;
        this.isAuthenticated = isAuth;
        console.log(`[ReactiveConvexClient] Auth state changed: ${isAuth}`);

        // Notify if auth was lost
        if (wasAuthenticated && !isAuth) {
          this.onAuthInvalid?.();
        }
      }
    );
  }

  /**
   * Subscribe to a query with reactive updates.
   *
   * Returns an unsubscribe function that also provides getCurrentValue().
   *
   * @param query - The Convex query function reference
   * @param args - Arguments to pass to the query
   * @param onUpdate - Callback when query result changes
   * @param onError - Optional error callback (throws if not provided)
   */
  subscribe<Query extends FunctionReference<"query">>(
    query: Query,
    args: FunctionArgs<Query>,
    onUpdate: (result: FunctionReturnType<Query>) => void,
    onError?: (error: Error) => void
  ): Unsubscribe<FunctionReturnType<Query>> {
    return this.client.onUpdate(query, args, onUpdate, onError);
  }

  /**
   * Execute a mutation.
   *
   * @param mutation - The Convex mutation function reference
   * @param args - Arguments to pass to the mutation
   */
  async mutation<Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>
  ): Promise<FunctionReturnType<Mutation>> {
    return this.client.mutation(mutation, args);
  }

  /**
   * Execute a one-shot query (non-reactive).
   *
   * @param query - The Convex query function reference
   * @param args - Arguments to pass to the query
   */
  async query<Query extends FunctionReference<"query">>(
    query: Query,
    args: FunctionArgs<Query>
  ): Promise<FunctionReturnType<Query>> {
    return this.client.query(query, args);
  }

  /**
   * Execute an action.
   *
   * @param action - The Convex action function reference
   * @param args - Arguments to pass to the action
   */
  async action<Action extends FunctionReference<"action">>(
    action: Action,
    args: FunctionArgs<Action>
  ): Promise<FunctionReturnType<Action>> {
    return this.client.action(action, args);
  }

  /**
   * Get the underlying ConvexClient instance.
   * Use sparingly - prefer the typed helpers.
   */
  getClient(): ConvexClient {
    return this.client;
  }

  /**
   * Get the current connection state.
   */
  getConnectionState() {
    return this.client.connectionState();
  }

  /**
   * Subscribe to connection state changes.
   */
  onConnectionStateChange(
    callback: (state: ReturnType<ConvexClient["connectionState"]>) => void
  ): () => void {
    return this.client.subscribeToConnectionState(callback);
  }

  /**
   * Close the client connection.
   * Should be called when the app is quitting.
   */
  async close(): Promise<void> {
    await this.client.close();
  }
}

// Singleton instance
let instance: ReactiveConvexClient | null = null;

/**
 * Get the singleton ReactiveConvexClient instance.
 *
 * @param options - Optional configuration (only applied on first call)
 */
export function getReactiveConvexClient(
  options?: ReactiveConvexClientOptions
): ReactiveConvexClient {
  if (!instance) {
    instance = new ReactiveConvexClient();
    if (options?.getAuthToken) {
      instance.setTokenProvider(options.getAuthToken);
    }
    if (options?.onAuthInvalid) {
      instance.setAuthInvalidCallback(options.onAuthInvalid);
    }
  }
  return instance;
}

export { ReactiveConvexClient };
