import { randomUUID } from "node:crypto";
import { LinkedInClient } from "../adapters/linkedin/api/client.js";
import {
  API_URLS,
  CONTENT_TYPES,
  DEFAULT_HEADERS,
  USER_AGENT,
} from "../adapters/linkedin/api/constants.js";
import type { Cookie, RealtimeEventEnvelope } from "../adapters/linkedin/api/types.js";

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;

export type LinkedInRealtimeState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "degraded"
  | "stopped";

export interface LinkedInRealtimeStatus {
  platform: "linkedin";
  accountKey: string;
  state: LinkedInRealtimeState;
  connectedAt: number | null;
  lastEventAt: number | null;
  lastReconnectAt: number | null;
  reconnectAttempts: number;
  lastSessionError: string | null;
}

interface LinkedInRealtimeSessionOptions {
  accountKey: string;
  cookies: Cookie[];
  pageInstance: string;
  xLiTrack: string;
  serviceVersion?: string | null;
  realtimeQueryMap: string;
  realtimeRecipeMap: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onEvent?: (accountKey: string, event: RealtimeEventEnvelope, userEntityUrn: string) => void;
  onConnected?: (status: LinkedInRealtimeStatus, reconnected: boolean) => void;
  onDisconnected?: (status: LinkedInRealtimeStatus) => void;
  onStatusChange?: (status: LinkedInRealtimeStatus) => void;
}

export interface LinkedInRealtimeSessionLike {
  start(): void;
  stop(): void;
  getStatus(): LinkedInRealtimeStatus;
  isConnected(): boolean;
}

export interface LinkedInRealtimeSupervisorSessionInput {
  accountKey: string;
  cookies: Cookie[];
  pageInstance: string;
  xLiTrack: string;
  serviceVersion?: string | null;
  realtimeQueryMap: string;
  realtimeRecipeMap: string;
}

interface LinkedInRealtimeSupervisorOptions {
  createSession?: (input: LinkedInRealtimeSupervisorSessionInput) => LinkedInRealtimeSessionLike;
  onEvent?: (accountKey: string, event: RealtimeEventEnvelope, userEntityUrn: string) => void;
  onConnected?: (accountKey: string, status: LinkedInRealtimeStatus, reconnected: boolean) => void;
  onDisconnected?: (accountKey: string, status: LinkedInRealtimeStatus) => void;
  onStatusChange?: (accountKey: string, status: LinkedInRealtimeStatus) => void;
}

function now(): number {
  return Date.now();
}

function getCsrfToken(cookies: Cookie[]): string | null {
  const cookie = cookies.find((item) => item.name === "JSESSIONID");
  return cookie ? cookie.value.replace(/^"|"$/g, "") : null;
}

function cookieHeader(cookies: Cookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function isAuthUrl(url: string | null): boolean {
  return Boolean(url && /linkedin\.com\/(?:login|checkpoint|authwall)/i.test(url));
}

function responseCookies(response: Response): string[] {
  const getSetCookie = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.bind(response.headers);
  if (typeof getSetCookie === "function") {
    return getSetCookie();
  }
  const combined = response.headers.get("set-cookie");
  return combined ? [combined] : [];
}

function isAuthInvalidation(response: Response): boolean {
  if (response.redirected && isAuthUrl(response.url)) {
    return true;
  }
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && isAuthUrl(location)) {
    return true;
  }
  return responseCookies(response).some(
    (cookie) => /\bli_at=(?:delete me)?\b/i.test(cookie) || /\bli_at=;\b/i.test(cookie),
  );
}

function toMemberUrn(value: string): string {
  return value.replace(/^urn:li:fsd_profile:/, "urn:li:member:");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function baseHeaders(cookies: Cookie[]): Record<string, string> {
  return {
    ...DEFAULT_HEADERS,
    Accept: CONTENT_TYPES.linkedInNormalized,
    "User-Agent": USER_AGENT,
    Cookie: cookieHeader(cookies),
  };
}

function parseServiceVersion(serviceVersion: string | null | undefined, xLiTrack: string): string {
  if (serviceVersion && serviceVersion.trim().length > 0) {
    return serviceVersion.trim();
  }
  try {
    const parsed = JSON.parse(xLiTrack) as { clientVersion?: unknown; mpVersion?: unknown };
    if (typeof parsed.clientVersion === "string" && parsed.clientVersion.trim().length > 0) {
      return parsed.clientVersion.trim();
    }
    if (typeof parsed.mpVersion === "string" && parsed.mpVersion.trim().length > 0) {
      return parsed.mpVersion.trim();
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

function makeStatus(input: {
  accountKey: string;
  state?: LinkedInRealtimeState;
  connectedAt?: number | null;
  lastEventAt?: number | null;
  lastReconnectAt?: number | null;
  reconnectAttempts?: number;
  lastSessionError?: string | null;
}): LinkedInRealtimeStatus {
  return {
    platform: "linkedin",
    accountKey: input.accountKey,
    state: input.state ?? "stopped",
    connectedAt: input.connectedAt ?? null,
    lastEventAt: input.lastEventAt ?? null,
    lastReconnectAt: input.lastReconnectAt ?? null,
    reconnectAttempts: input.reconnectAttempts ?? 0,
    lastSessionError: input.lastSessionError ?? null,
  };
}

export class LinkedInRealtimeSession implements LinkedInRealtimeSessionLike {
  private readonly accountKey: string;
  private readonly cookies: Cookie[];
  private readonly pageInstance: string;
  private readonly xLiTrack: string;
  private readonly serviceVersion: string;
  private readonly realtimeQueryMap: string;
  private readonly realtimeRecipeMap: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly onEvent?: (
    accountKey: string,
    event: RealtimeEventEnvelope,
    userEntityUrn: string,
  ) => void;
  private readonly onConnected?: (status: LinkedInRealtimeStatus, reconnected: boolean) => void;
  private readonly onDisconnected?: (status: LinkedInRealtimeStatus) => void;
  private readonly onStatusChange?: (status: LinkedInRealtimeStatus) => void;

  private status: LinkedInRealtimeStatus;
  private shouldReconnect = false;
  private hasEverConnected = false;
  private controller: AbortController | null = null;
  private realtimeSessionId = randomUUID();
  private userEntityUrn: string | null = null;

  constructor(options: LinkedInRealtimeSessionOptions) {
    this.accountKey = options.accountKey;
    this.cookies = options.cookies;
    this.pageInstance = options.pageInstance;
    this.xLiTrack = options.xLiTrack;
    this.serviceVersion = parseServiceVersion(options.serviceVersion ?? null, options.xLiTrack);
    this.realtimeQueryMap = options.realtimeQueryMap;
    this.realtimeRecipeMap = options.realtimeRecipeMap;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.onEvent = options.onEvent;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onStatusChange = options.onStatusChange;
    this.status = makeStatus({ accountKey: this.accountKey });
  }

  start(): void {
    if (this.shouldReconnect) {
      return;
    }
    this.shouldReconnect = true;
    this.setStatus({
      state: this.hasEverConnected ? "reconnecting" : "connecting",
      lastSessionError: null,
    });
    void this.runLoop();
  }

  stop(): void {
    this.shouldReconnect = false;
    this.controller?.abort();
    this.controller = null;
    this.setStatus({
      state: "stopped",
      connectedAt: null,
      lastSessionError: null,
    });
  }

  getStatus(): LinkedInRealtimeStatus {
    return { ...this.status };
  }

  isConnected(): boolean {
    return this.status.state === "connected";
  }

  private setStatus(patch: Partial<LinkedInRealtimeStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatusChange?.(this.getStatus());
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;
    while (this.shouldReconnect) {
      this.controller = new AbortController();
      try {
        await this.ensureUserEntityUrn();
        this.realtimeSessionId = randomUUID();
        await this.connectOnce(this.controller.signal);
        attempt = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.shouldReconnect) {
          break;
        }
        if (/auth/i.test(message) || /credential/i.test(message)) {
          this.setStatus({
            state: "degraded",
            connectedAt: null,
            lastSessionError: message,
          });
          return;
        }
        attempt += 1;
        this.setStatus({
          state: this.hasEverConnected ? "reconnecting" : "connecting",
          connectedAt: null,
          lastReconnectAt: now(),
          reconnectAttempts: attempt,
          lastSessionError: message,
        });
        await wait(
          Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.max(0, attempt - 1)),
        ).catch(() => undefined);
      } finally {
        this.controller?.abort();
        this.controller = null;
      }
    }
  }

  private async ensureUserEntityUrn(): Promise<void> {
    if (this.userEntityUrn) {
      return;
    }
    const client = new LinkedInClient({
      cookies: this.cookies,
      pageInstance: this.pageInstance,
      xLiTrack: this.xLiTrack,
    });
    this.userEntityUrn = toMemberUrn(await client.fetchSelf());
  }

  private async connectOnce(signal: AbortSignal): Promise<void> {
    const response = await fetch(`${API_URLS.realtimeConnect}?rc=1`, {
      method: "GET",
      headers: {
        ...baseHeaders(this.cookies),
        Accept: "text/event-stream",
        Referer: `${API_URLS.messagingBase}/`,
        "csrf-token": getCsrfToken(this.cookies) ?? "",
        Priority: "u=1, i",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "x-li-page-instance": this.pageInstance,
        "x-li-track": this.xLiTrack,
        "x-li-accept": CONTENT_TYPES.linkedInNormalized,
        "x-li-query-accept": CONTENT_TYPES.graphql,
        "x-li-query-map": this.realtimeQueryMap,
        "x-li-recipe-accept": CONTENT_TYPES.linkedInNormalized,
        "x-li-recipe-map": this.realtimeRecipeMap,
        "x-li-realtime-session": this.realtimeSessionId,
      },
      redirect: "manual",
      signal,
    });

    if (response.status === 400) {
      throw new Error("LinkedIn realtime connect rejected the current session");
    }
    if (response.status === 401 || response.status === 403 || isAuthInvalidation(response)) {
      throw new Error(`LinkedIn realtime auth failed (${response.status})`);
    }
    if (!response.ok || !response.body) {
      throw new Error(`LinkedIn realtime connect failed (${response.status})`);
    }

    const connectedAt = now();
    const reconnected = this.hasEverConnected;
    this.hasEverConnected = true;
    this.setStatus({
      state: "connected",
      connectedAt,
      lastReconnectAt: reconnected ? connectedAt : this.status.lastReconnectAt,
      lastSessionError: null,
    });
    this.onConnected?.(this.getStatus(), reconnected);

    const heartbeatPromise = this.runHeartbeatLoop(signal);
    try {
      await Promise.race([this.readStream(response.body, signal), heartbeatPromise]);
      if (!signal.aborted) {
        this.onDisconnected?.(this.getStatus());
        throw new Error("LinkedIn realtime stream closed");
      }
    } finally {
      await heartbeatPromise.catch(() => undefined);
    }
  }

  private async runHeartbeatLoop(signal: AbortSignal): Promise<void> {
    let isFirstHeartbeat = true;
    while (!signal.aborted && this.userEntityUrn) {
      try {
        const response = await fetch(`${API_URLS.realtimeHeartbeat}?action=sendHeartbeat`, {
          method: "POST",
          headers: {
            ...baseHeaders(this.cookies),
            Accept: "*/*",
            Origin: "https://www.linkedin.com",
            Priority: "u=1, i",
            Referer: `${API_URLS.messagingBase}/`,
            "Content-Type": "text/plain;charset=UTF-8",
            "csrf-token": getCsrfToken(this.cookies) ?? "",
            "x-li-page-instance": this.pageInstance,
            "x-li-track": this.xLiTrack,
          },
          body: JSON.stringify({
            isFirstHeartbeat,
            isLastHeartbeat: false,
            realtimeSessionId: this.realtimeSessionId,
            mpName: "voyager-web",
            mpVersion: this.serviceVersion,
            clientId: "voyager-web",
            actorUrn: this.userEntityUrn.replace(/^urn:li:member:/, "urn:li:fsd_profile:"),
            contextUrns: [this.userEntityUrn.replace(/^urn:li:member:/, "urn:li:fsd_profile:")],
          }),
          redirect: "manual",
          signal,
        });
        if (response.status === 401 || response.status === 403 || isAuthInvalidation(response)) {
          throw new Error(`LinkedIn realtime auth failed (${response.status})`);
        }
        isFirstHeartbeat = false;
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
      }
      await wait(HEARTBEAT_INTERVAL_MS, signal).catch(() => undefined);
    }
  }

  private async readStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) {
            continue;
          }
          const payload = trimmed.slice(5).trim();
          if (!payload) {
            continue;
          }
          try {
            const event = JSON.parse(payload) as RealtimeEventEnvelope;
            this.setStatus({ lastEventAt: now() });
            if (event["com.linkedin.realtimefrontend.DecoratedEvent"] && this.userEntityUrn) {
              this.onEvent?.(this.accountKey, event, this.userEntityUrn);
            }
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export class LinkedInRealtimeSupervisor {
  private readonly createSession: (
    input: LinkedInRealtimeSupervisorSessionInput,
  ) => LinkedInRealtimeSessionLike;
  private readonly sessions = new Map<string, LinkedInRealtimeSessionLike>();
  private readonly degradedStatuses = new Map<string, LinkedInRealtimeStatus>();

  constructor(options: LinkedInRealtimeSupervisorOptions = {}) {
    this.createSession =
      options.createSession ??
      ((input) =>
        new LinkedInRealtimeSession({
          ...input,
          onEvent: (accountKey, event, userEntityUrn) =>
            options.onEvent?.(accountKey, event, userEntityUrn),
          onConnected: (status, reconnected) =>
            options.onConnected?.(input.accountKey, status, reconnected),
          onDisconnected: (status) => options.onDisconnected?.(input.accountKey, status),
          onStatusChange: (status) => options.onStatusChange?.(input.accountKey, status),
        }));
  }

  reconcile(
    desired: LinkedInRealtimeSupervisorSessionInput[],
    degraded: Array<Omit<LinkedInRealtimeStatus, "platform">>,
  ): void {
    const desiredMap = new Map(desired.map((item) => [item.accountKey, item]));

    for (const [accountKey, session] of this.sessions.entries()) {
      if (desiredMap.has(accountKey)) {
        continue;
      }
      session.stop();
      this.sessions.delete(accountKey);
    }

    this.degradedStatuses.clear();
    for (const status of degraded) {
      this.degradedStatuses.set(status.accountKey, {
        platform: "linkedin",
        ...status,
      });
    }

    for (const sessionInput of desired) {
      if (this.sessions.has(sessionInput.accountKey)) {
        continue;
      }
      const session = this.createSession(sessionInput);
      this.sessions.set(sessionInput.accountKey, session);
      session.start();
    }
  }

  getSession(accountKey: string): LinkedInRealtimeSessionLike | null {
    return this.sessions.get(accountKey) ?? null;
  }

  getStatus(accountKey: string): LinkedInRealtimeStatus | null {
    const session = this.sessions.get(accountKey);
    if (session) {
      return session.getStatus();
    }
    return this.degradedStatuses.get(accountKey) ?? null;
  }

  getStatuses(): LinkedInRealtimeStatus[] {
    const sessionStatuses = [...this.sessions.values()].map((session) => session.getStatus());
    return [...sessionStatuses, ...this.degradedStatuses.values()].sort((left, right) =>
      left.accountKey.localeCompare(right.accountKey),
    );
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this.sessions.clear();
  }
}
