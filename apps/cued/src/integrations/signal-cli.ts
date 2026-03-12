import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { CUED_SIGNAL_DIR } from "../config.js";

const execFileAsync = promisify(execFile);
const SIGNAL_CLI_COMMON_PATHS = [
  "/opt/homebrew/bin/signal-cli",
  "/usr/local/bin/signal-cli",
] as const;
const MIN_SIGNAL_CLI_VERSION = { major: 0, minor: 13, patch: 0 } as const;
const DEFAULT_RECEIVE_TIMEOUT_SECONDS = 1;

export interface SignalCliVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export interface SignalContact {
  number?: string;
  uuid?: string;
  name?: string;
  givenName?: string | null;
  familyName?: string | null;
  profile?: {
    givenName?: string | null;
    familyName?: string | null;
  } | null;
  isBlocked?: boolean;
  unregistered?: boolean;
}

export interface SignalGroup {
  id?: string;
  groupId?: string;
  name?: string;
  title?: string;
  members?: Array<{
    uuid?: string;
    number?: string;
  }>;
}

export interface SignalReceivedMessage {
  messageId: string;
  threadId: string;
  threadType: "dm" | "group";
  threadName?: string;
  text: string;
  sentAt: number;
  isFromMe: boolean;
  senderHandle?: string;
  senderName?: string;
  peerHandle?: string;
  attachments: Array<Record<string, unknown>>;
}

export interface SignalSendResult {
  timestamp: number;
}

export interface SignalLinkHandle {
  child: ChildProcess;
  provisioningUri: Promise<string>;
  completion: Promise<void>;
  cancel: () => void;
}

interface SignalClientOptions {
  account: string;
  cliPath?: string;
  configDir?: string;
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  timestamp?: number;
  serverGuid?: string;
  envelopeId?: string;
  dataMessage?: {
    message?: string;
    timestamp?: number;
    attachments?: Array<Record<string, unknown>>;
    groupInfo?: {
      groupId?: string;
      name?: string;
    };
  };
  syncMessage?: {
    sentMessage?: {
      message?: string;
      timestamp?: number;
      destination?: string;
      destinationNumber?: string;
      destinationUuid?: string;
      attachments?: Array<Record<string, unknown>>;
      groupInfo?: {
        groupId?: string;
        name?: string;
      };
    };
  };
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase();
}

function makeSignalConfigDir(accountKey: string): string {
  return join(CUED_SIGNAL_DIR, accountKey);
}

export function getSignalConfigDir(accountKey: string): string {
  const path = makeSignalConfigDir(accountKey);
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return path;
}

export function resolveSignalCliPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.CUED_SIGNAL_CLI_PATH?.trim();
  if (explicit) {
    return explicit;
  }

  try {
    const { stdout } = execFileSyncCompat("which", ["signal-cli"]);
    const resolved = stdout.trim();
    if (resolved.length > 0) {
      return resolved;
    }
  } catch {
    // fall through
  }

  for (const candidate of SIGNAL_CLI_COMMON_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function execFileSyncCompat(file: string, args: string[]): { stdout: string } {
  return {
    stdout: execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  };
}

export function parseSignalCliVersion(stdout: string): SignalCliVersion | null {
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: match[0],
  };
}

export function isSignalCliVersionSupported(version: SignalCliVersion | null): boolean {
  if (!version) {
    return false;
  }
  if (version.major !== MIN_SIGNAL_CLI_VERSION.major) {
    return version.major > MIN_SIGNAL_CLI_VERSION.major;
  }
  if (version.minor !== MIN_SIGNAL_CLI_VERSION.minor) {
    return version.minor > MIN_SIGNAL_CLI_VERSION.minor;
  }
  return version.patch >= MIN_SIGNAL_CLI_VERSION.patch;
}

export async function inspectSignalCli(env: NodeJS.ProcessEnv = process.env): Promise<{
  cliPath: string | null;
  version: SignalCliVersion | null;
}> {
  const cliPath = resolveSignalCliPath(env);
  if (!cliPath) {
    return { cliPath: null, version: null };
  }

  try {
    const { stdout, stderr } = await execFileAsync(cliPath, ["--version"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      cliPath,
      version: parseSignalCliVersion(`${stdout}\n${stderr}`),
    };
  } catch {
    return { cliPath, version: null };
  }
}

export function readSignalLinkedAccount(configDir: string): string | null {
  const accountsPath = join(configDir, "data", "accounts.json");
  if (!existsSync(accountsPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(accountsPath, "utf8")) as {
      accounts?: Array<{ number?: string }>;
    };
    const account = parsed.accounts?.at(-1)?.number?.trim();
    return account && account.length > 0 ? account : null;
  } catch {
    return null;
  }
}

function parseJsonObjects(output: string): unknown[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  const objects: unknown[] = [];
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      objects.push(JSON.parse(candidate));
    } catch {
      // Ignore logs and partial lines.
    }
  }
  return objects;
}

function isLikelyPhone(value: string): boolean {
  return /^[+]?\d[\d\s()-]{5,}$/.test(value.trim());
}

function bestContactHandle(contact: SignalContact): string | null {
  if (typeof contact.number === "string" && contact.number.trim().length > 0) {
    return contact.number.trim();
  }
  if (typeof contact.uuid === "string" && contact.uuid.trim().length > 0) {
    return contact.uuid.trim().toLowerCase();
  }
  return null;
}

export function contactHandleType(handle: string): "phone" | "signal_id" {
  return isLikelyPhone(handle) ? "phone" : "signal_id";
}

export function bestSignalContactName(contact: SignalContact): string {
  return (
    contact.name?.trim() ||
    [contact.profile?.givenName, contact.profile?.familyName].filter(Boolean).join(" ").trim() ||
    [contact.givenName, contact.familyName].filter(Boolean).join(" ").trim() ||
    bestContactHandle(contact) ||
    "Signal Contact"
  );
}

function bestSourceHandle(envelope: SignalEnvelope): string | undefined {
  return (
    envelope.sourceNumber?.trim() ||
    envelope.source?.trim() ||
    envelope.sourceUuid?.trim()?.toLowerCase() ||
    undefined
  );
}

export function makeSignalMessageFallbackId(options: {
  timestamp: number;
  threadId: string;
  isFromMe: boolean;
  text: string;
  fallbackIndex: number;
}): string {
  const direction = options.isFromMe ? "out" : "in";
  return `${options.timestamp}:${direction}:${options.threadId}:${options.text.slice(0, 32)}:${options.fallbackIndex}`;
}

function makeMessageId(
  envelope: SignalEnvelope,
  threadId: string,
  isFromMe: boolean,
  text: string,
  fallbackIndex: number,
): string {
  const serverGuid = envelope.serverGuid?.trim() || envelope.envelopeId?.trim();
  if (serverGuid) {
    return serverGuid;
  }

  const timestamp =
    envelope.dataMessage?.timestamp ??
    envelope.syncMessage?.sentMessage?.timestamp ??
    envelope.timestamp ??
    Date.now();
  return makeSignalMessageFallbackId({
    timestamp,
    threadId,
    isFromMe,
    text,
    fallbackIndex,
  });
}

export function toSignalMessage(
  raw: unknown,
  account: string,
  index: number,
): SignalReceivedMessage | null {
  const root = raw as { envelope?: SignalEnvelope };
  const envelope = root.envelope ?? (raw as SignalEnvelope);
  const dataMessage = envelope.dataMessage;
  const sentMessage = envelope.syncMessage?.sentMessage;
  const text = dataMessage?.message ?? sentMessage?.message;
  if (!text || text.trim().length === 0) {
    return null;
  }

  const groupInfo = dataMessage?.groupInfo ?? sentMessage?.groupInfo;
  const groupId = groupInfo?.groupId?.trim();
  const groupName = groupInfo?.name?.trim();
  const source = bestSourceHandle(envelope);
  const isFromMe =
    Boolean(sentMessage) || (source ? normalizeHandle(source) === normalizeHandle(account) : false);
  const peerHandle = groupId
    ? undefined
    : isFromMe
      ? sentMessage?.destinationNumber?.trim() ||
        sentMessage?.destination?.trim() ||
        sentMessage?.destinationUuid?.trim()?.toLowerCase()
      : source;
  const threadId = groupId
    ? `group:${groupId}`
    : peerHandle
      ? `dm:${normalizeHandle(peerHandle)}`
      : "dm:unknown";
  const timestamp = Number(
    dataMessage?.timestamp ?? sentMessage?.timestamp ?? envelope.timestamp ?? Date.now(),
  );
  const attachments = (dataMessage?.attachments ?? sentMessage?.attachments ?? []).filter(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
  );

  return {
    messageId: makeMessageId(envelope, threadId, isFromMe, text, index),
    threadId,
    threadType: groupId ? "group" : "dm",
    threadName: groupName || undefined,
    text,
    sentAt: timestamp,
    isFromMe,
    senderHandle: isFromMe ? undefined : source,
    senderName: isFromMe ? undefined : envelope.sourceName?.trim() || undefined,
    peerHandle: peerHandle || undefined,
    attachments,
  };
}

export class SignalCliClient {
  private readonly account: string;
  private readonly cliPath: string;
  private readonly configDir: string;

  constructor(options: SignalClientOptions) {
    this.account = options.account;
    this.cliPath = options.cliPath ?? resolveSignalCliPath() ?? "signal-cli";
    this.configDir = options.configDir ?? getSignalConfigDir("default");
  }

  getCliPath(): string {
    return this.cliPath;
  }

  getAccount(): string {
    return this.account;
  }

  getConfigDir(): string {
    return this.configDir;
  }

  async getVersion(): Promise<SignalCliVersion | null> {
    const { stdout, stderr } = await execFileAsync(this.cliPath, ["--version"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return parseSignalCliVersion(`${stdout}\n${stderr}`);
  }

  async listContacts(): Promise<SignalContact[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      this.accountArgs(["-o", "json", "listContacts"]),
      {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    return parseJsonObjects(stdout)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value): value is SignalContact => typeof value === "object" && value !== null)
      .filter((contact) => {
        const handle = bestContactHandle(contact);
        return (
          Boolean(handle) &&
          !contact.isBlocked &&
          !contact.unregistered &&
          normalizeHandle(handle!) !== normalizeHandle(this.account)
        );
      });
  }

  async listGroups(): Promise<SignalGroup[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      this.accountArgs(["-o", "json", "listGroups"]),
      {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    return parseJsonObjects(stdout)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value): value is SignalGroup => typeof value === "object" && value !== null);
  }

  async receiveMessages(
    timeoutSeconds = DEFAULT_RECEIVE_TIMEOUT_SECONDS,
  ): Promise<SignalReceivedMessage[]> {
    const { stdout } = await execFileAsync(
      this.cliPath,
      this.accountArgs(["-o", "json", "receive", "--timeout", String(timeoutSeconds)]),
      {
        timeout: Math.max(30_000, timeoutSeconds * 2_000 + 25_000),
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    return parseJsonObjects(stdout)
      .map((value, index) => toSignalMessage(value, this.account, index))
      .filter((value): value is SignalReceivedMessage => value !== null);
  }

  async sendMessage(
    text: string,
    target: { recipient?: string; groupId?: string },
  ): Promise<SignalSendResult> {
    const message = text.trim();
    if (message.length === 0) {
      throw new Error("Signal message text is required");
    }

    const args = this.accountArgs(["send", "-m", message]);
    if (target.groupId) {
      args.push("-g", target.groupId);
    } else if (target.recipient) {
      args.push(target.recipient);
    } else {
      throw new Error("Signal message requires a recipient or groupId");
    }

    const { stdout } = await execFileAsync(this.cliPath, args, {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    const timestampMatch = stdout.match(/\d{10,16}/);
    return {
      timestamp: timestampMatch ? Number(timestampMatch[0]) : Date.now(),
    };
  }

  accountArgs(args: string[]): string[] {
    return ["--config", this.configDir, "-u", this.account, ...args];
  }
}

export function startSignalLinkSession(options: {
  cliPath: string;
  configDir: string;
  deviceName: string;
}): SignalLinkHandle {
  const args = ["--config", options.configDir, "link", "-n", options.deviceName];
  const child = spawn(options.cliPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let settledUri = false;
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const provisioningUri = new Promise<string>((resolve, reject) => {
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutBuffer += text;
      const match = `${stdoutBuffer}\n${stderrBuffer}`.match(/sgnl:\/\/linkdevice\?uuid=[^\s]+/);
      if (match && !settledUri) {
        settledUri = true;
        resolve(match[0]);
      }
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuffer += text;
      const match = `${stdoutBuffer}\n${stderrBuffer}`.match(/sgnl:\/\/linkdevice\?uuid=[^\s]+/);
      if (match && !settledUri) {
        settledUri = true;
        resolve(match[0]);
      }
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (!settledUri) {
        reject(
          new Error(
            stderrBuffer.trim() ||
              stdoutBuffer.trim() ||
              `signal-cli link exited with code ${code ?? "unknown"}`,
          ),
        );
      }
    });
  });

  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderrBuffer.trim() ||
            stdoutBuffer.trim() ||
            `signal-cli link exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });

  return {
    child,
    provisioningUri,
    completion,
    cancel: () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}
