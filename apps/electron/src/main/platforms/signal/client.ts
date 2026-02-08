/**
 * Signal CLI client wrapper.
 *
 * Uses local signal-cli binary for send/receive operations.
 * This keeps Signal integration local to the desktop app.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { chmod, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SignalDaemon } from './daemon'

const execFileAsync = promisify(execFile)

const DEFAULT_SIGNAL_CLI_PATH = 'signal-cli'
const SIGNAL_CLI_VERSION = '0.13.24'
const SIGNAL_CLI_TARBALL_URL = `https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz`

/**
 * Check whether Java 21+ is available on the system.
 */
export async function checkJavaAvailable(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('java', ['-version'], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    })
    const output = stderr || stdout // java -version writes to stderr
    const versionMatch = output.match(/version "(\d+)/)
    if (versionMatch) {
      const major = parseInt(versionMatch[1]!, 10)
      if (major < 21) {
        return { ok: false, error: `Java ${major} found but Java 21+ is required. Install from https://adoptium.net` }
      }
    }
    return { ok: true }
  } catch {
    return {
      ok: false,
      error: 'Java not found. signal-cli requires Java 21+. Install from https://adoptium.net',
    }
  }
}

/**
 * Download and extract signal-cli from GitHub releases.
 * Returns the path to the signal-cli binary.
 */
export async function downloadSignalCli(installDir: string): Promise<string> {
  mkdirSync(installDir, { recursive: true })

  const tarPath = join(tmpdir(), `signal-cli-${SIGNAL_CLI_VERSION}.tar.gz`)

  // Download the tarball using curl (available on all macOS)
  try {
    await execFileAsync('curl', ['-L', '-o', tarPath, SIGNAL_CLI_TARBALL_URL], {
      timeout: 300000, // 5 min
      maxBuffer: 1024 * 1024,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to download signal-cli: ${msg}`)
  }

  // Extract the tarball
  try {
    await execFileAsync('tar', ['xzf', tarPath, '-C', installDir], {
      timeout: 60000,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to extract signal-cli: ${msg}`)
  }

  // The tarball extracts to signal-cli-VERSION/. Move contents up.
  const extractedDir = join(installDir, `signal-cli-${SIGNAL_CLI_VERSION}`)
  const finalBin = join(installDir, 'bin', 'signal-cli')

  if (existsSync(extractedDir) && !existsSync(finalBin)) {
    // Move contents from extracted dir to installDir
    const entries = await readdir(extractedDir)
    for (const entry of entries) {
      const src = join(extractedDir, entry)
      const dest = join(installDir, entry)
      if (existsSync(dest)) await rm(dest, { recursive: true })
      await rename(src, dest)
    }
    await rm(extractedDir, { recursive: true, force: true })
  }

  // Make the binary executable
  if (existsSync(finalBin)) {
    await chmod(finalBin, 0o755)
  }

  // Clean up tarball
  await rm(tarPath, { force: true })

  if (!existsSync(finalBin)) {
    throw new Error(`signal-cli binary not found after extraction at ${finalBin}`)
  }

  return finalBin
}

/**
 * Validate a path is absolute and contains only safe characters.
 * Prevents shell injection when paths are interpolated into scripts.
 */
function sanitizePathForShell(path: string, label: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`${label} must be an absolute path, got: ${path}`)
  }
  // Allowlist: only permit alphanumeric, slashes, dashes, underscores, dots, and spaces
  if (!/^[a-zA-Z0-9/_. -]+$/.test(path)) {
    throw new Error(`${label} contains invalid characters: ${path}`)
  }
  return path
}

/**
 * Open Terminal.app with a script that runs `signal-cli link` and displays a QR code.
 * Writes the linked account number to resultFile on success.
 */
export async function openLinkTerminal(
  cliPath: string,
  resultFile: string,
): Promise<void> {
  const safeCli = sanitizePathForShell(cliPath, 'cliPath')
  const safeResultFile = sanitizePathForShell(resultFile, 'resultFile')

  const script = `#!/bin/bash
set -uo pipefail

CLI="${safeCli}"
RESULT_FILE="${safeResultFile}"

echo "================================================"
echo "  Signal Device Linking — Cued Desktop"
echo "================================================"
echo ""
echo "Starting link process..."
echo ""

# Run signal-cli link in background writing to a temp file.
# Using a pipe would cause SIGPIPE when the reader finishes.
URI_FILE=$(mktemp)
"$CLI" link -n "Cued Desktop" > "$URI_FILE" 2>/dev/null &
LINK_PID=$!
trap 'rm -f "$URI_FILE"; kill $LINK_PID 2>/dev/null' EXIT

# Poll for the URI to appear (signal-cli prints it then blocks)
URI=""
for i in $(seq 1 60); do
  if [ -s "$URI_FILE" ]; then
    URI=$(head -1 "$URI_FILE")
    if [ -n "$URI" ]; then
      break
    fi
  fi
  sleep 1
done

if [ -z "$URI" ]; then
  echo "Timed out waiting for signal-cli to produce a link URI."
  exit 1
fi

echo "Open Signal on your phone:"
echo "  Settings > Linked Devices > + (Link New Device)"
echo ""

# Show QR code via Python segno in a temp venv
# $URI is passed via env var to avoid shell injection from signal-cli output
QR_VENV=$(mktemp -d)
QR_OK=false
if python3 -m venv "$QR_VENV" 2>/dev/null; then
  if "$QR_VENV/bin/pip" install -q segno 2>/dev/null; then
    if URI="$URI" "$QR_VENV/bin/python" -c "import os, segno; segno.make(os.environ['URI']).terminal(compact=True)" 2>/dev/null; then
      QR_OK=true
    fi
  fi
fi
rm -rf "$QR_VENV"

if [ "$QR_OK" = false ]; then
  echo "URI: $URI"
  echo ""
  echo "Paste this URI into a QR code generator to scan it."
fi

echo ""
echo "Waiting for you to scan the QR code..."
echo "(This will complete automatically once you scan)"
echo ""

# Wait for signal-cli link to finish (it exits after successful scan)
wait $LINK_PID
LINK_EXIT=$?

if [ $LINK_EXIT -ne 0 ]; then
  echo "Linking failed (exit code $LINK_EXIT)."
  echo "You can close this terminal window and try again."
  exit 1
fi

# Find the linked account from signal-cli's accounts.json.
# signal-cli stores data in ~/.local/share/signal-cli/data/ (XDG default on macOS).
ACCOUNTS_JSON="$HOME/.local/share/signal-cli/data/accounts.json"
if [ -f "$ACCOUNTS_JSON" ]; then
  # Extract the first account number from accounts.json
  # Path passed via env var to avoid interpolation issues with special characters in path
  ACCOUNT=$(ACCOUNTS_JSON="$ACCOUNTS_JSON" python3 -c "
import os, json, sys
try:
    with open(os.environ['ACCOUNTS_JSON']) as f:
        data = json.load(f)
    accounts = data.get('accounts', [])
    if accounts:
        print(accounts[-1].get('number', ''))
except Exception:
    pass
" 2>/dev/null)
  if [ -n "$ACCOUNT" ]; then
    echo "$ACCOUNT" > "$RESULT_FILE"
    echo ""
    echo "Successfully linked as $ACCOUNT!"
    echo "You can close this terminal window."
    exit 0
  fi
fi

echo "linked" > "$RESULT_FILE"
echo ""
echo "Linking complete! You can close this terminal window."
`

  const scriptPath = join(tmpdir(), 'cued-signal-link.sh')
  writeFileSync(scriptPath, script, { mode: 0o755 })

  // Open Terminal.app with the script
  await execFileAsync('open', ['-a', 'Terminal', scriptPath], { timeout: 10000 })
}

export interface SignalContact {
  number: string
  name: string
  givenName?: string
  familyName?: string | null
  isBlocked: boolean
  unregistered: boolean
  profile?: {
    givenName?: string | null
    familyName?: string | null
  }
}

export interface SignalClientOptions {
  account: string
  cliPath?: string
}

export interface SignalReceivedMessage {
  messageId: string
  threadId: string
  threadType: 'dm' | 'group'
  threadName?: string
  text: string
  sentAt: number
  isFromMe: boolean
  senderHandle?: string
  senderName?: string
  peerHandle?: string
}

export interface SignalSendResult {
  timestamp: number
}

interface SignalEnvelope {
  source?: string
  sourceNumber?: string
  sourceName?: string
  timestamp?: number
  serverGuid?: string
  dataMessage?: {
    message?: string
    timestamp?: number
    groupInfo?: {
      groupId?: string
      name?: string
    }
  }
  syncMessage?: {
    sentMessage?: {
      message?: string
      timestamp?: number
      destination?: string
      destinationNumber?: string
      groupInfo?: {
        groupId?: string
        name?: string
      }
    }
  }
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase()
}

function parseJsonObjects(output: string): unknown[] {
  const trimmed = output.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  const objects: unknown[] = []
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim()
    if (!candidate.startsWith('{')) continue
    try {
      objects.push(JSON.parse(candidate))
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  return objects
}

function makeMessageId(
  envelope: SignalEnvelope,
  threadId: string,
  isFromMe: boolean,
  text: string,
  fallbackIndex: number
): string {
  if (envelope.serverGuid) {
    return envelope.serverGuid
  }
  const ts = envelope.dataMessage?.timestamp ?? envelope.syncMessage?.sentMessage?.timestamp ?? envelope.timestamp ?? Date.now()
  const direction = isFromMe ? 'out' : 'in'
  return `${ts}:${direction}:${threadId}:${text.slice(0, 32)}:${fallbackIndex}`
}

export function toSignalMessage(
  raw: unknown,
  account: string,
  index: number
): SignalReceivedMessage | null {
  const root = raw as { envelope?: SignalEnvelope }
  const envelope = root?.envelope ?? (raw as SignalEnvelope)

  const dataMessage = envelope?.dataMessage
  const sentMessage = envelope?.syncMessage?.sentMessage
  const text = dataMessage?.message ?? sentMessage?.message
  if (!text || text.trim().length === 0) {
    return null
  }

  const groupInfo = dataMessage?.groupInfo ?? sentMessage?.groupInfo
  const groupId = groupInfo?.groupId?.trim()
  const groupName = groupInfo?.name?.trim()

  const source = envelope?.sourceNumber ?? envelope?.source
  const isFromMe =
    Boolean(sentMessage) ||
    (source ? normalizeHandle(source) === normalizeHandle(account) : false)

  const peerHandle = groupId
    ? undefined
    : isFromMe
      ? sentMessage?.destinationNumber ?? sentMessage?.destination
      : source

  const threadId = groupId
    ? `group:${groupId}`
    : peerHandle
      ? `dm:${normalizeHandle(peerHandle)}`
      : 'dm:unknown'

  const timestamp =
    dataMessage?.timestamp ??
    sentMessage?.timestamp ??
    envelope?.timestamp ??
    Date.now()

  const messageId = makeMessageId(envelope, threadId, isFromMe, text, index)

  return {
    messageId,
    threadId,
    threadType: groupId ? 'group' : 'dm',
    threadName: groupName || undefined,
    text,
    sentAt: Number(timestamp),
    isFromMe,
    senderHandle: isFromMe ? undefined : source,
    senderName: isFromMe ? undefined : envelope?.sourceName,
    peerHandle: peerHandle || undefined,
  }
}

export class SignalClient {
  private readonly account: string
  private readonly cliPath: string
  private daemon: SignalDaemon | null = null

  constructor(options: SignalClientOptions) {
    this.account = options.account
    this.cliPath = options.cliPath ?? DEFAULT_SIGNAL_CLI_PATH
  }

  getAccount(): string {
    return this.account
  }

  getCliPath(): string {
    return this.cliPath
  }

  setDaemon(daemon: SignalDaemon | null): void {
    this.daemon = daemon
  }

  hasDaemon(): boolean {
    return this.daemon?.isConnected() ?? false
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.cliPath, ['--version'], {
        timeout: 4000,
        maxBuffer: 1024 * 1024,
      })
      return true
    } catch {
      return false
    }
  }

  async isAccountRegistered(): Promise<boolean> {
    try {
      await execFileAsync(this.cliPath, ['-u', this.account, 'listIdentities'], {
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
      })
      return true
    } catch {
      return false
    }
  }

  async sendMessage(
    text: string,
    target: { recipient?: string; groupId?: string }
  ): Promise<SignalSendResult> {
    const message = text.trim()
    if (!message) {
      throw new Error('Message text is required')
    }

    // Route through daemon when available
    if (this.daemon?.isConnected()) {
      const params: Record<string, unknown> = { message }
      if (target.groupId) {
        params.groupId = target.groupId
      } else if (target.recipient) {
        params.recipient = [target.recipient]
      } else {
        throw new Error('Signal message requires recipient or groupId')
      }

      const result = await this.daemon.request<{ timestamp?: number }>('send', params)
      return { timestamp: result?.timestamp ?? Date.now() }
    }

    // Fallback to one-shot execFileAsync
    const args = ['-u', this.account, 'send', '-m', message]

    if (target.groupId) {
      args.push('-g', target.groupId)
    } else if (target.recipient) {
      args.push(target.recipient)
    } else {
      throw new Error('Signal message requires recipient or groupId')
    }

    const { stdout } = await execFileAsync(this.cliPath, args, {
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
    })

    const tsMatch = stdout.match(/\d{10,16}/)
    return {
      timestamp: tsMatch ? Number(tsMatch[0]) : Date.now(),
    }
  }

  async listContacts(): Promise<SignalContact[]> {
    // Route through daemon when available
    if (this.daemon?.isConnected()) {
      const result = await this.daemon.request<SignalContact[]>('listContacts', {})
      if (!Array.isArray(result)) {
        console.warn('[SignalClient] Daemon listContacts returned non-array:', typeof result)
        return []
      }
      return result.filter(
        (c) => c.number && !c.isBlocked && !c.unregistered && c.number !== this.account
      )
    }

    // Fallback to one-shot execFileAsync
    const args = ['-u', this.account, '-o', 'json', 'listContacts']

    const { stdout } = await execFileAsync(this.cliPath, args, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    })

    const trimmed = stdout.trim()
    if (!trimmed) return []

    try {
      const parsed = JSON.parse(trimmed) as SignalContact[]
      return parsed.filter(
        (c) => c.number && !c.isBlocked && !c.unregistered && c.number !== this.account
      )
    } catch {
      return []
    }
  }

  async receiveMessages(timeoutSeconds: number = 1): Promise<SignalReceivedMessage[]> {
    // When daemon is running, messages arrive via real-time notifications — no need to poll
    if (this.daemon?.isConnected()) {
      return []
    }

    // Fallback to one-shot receive
    // -o json is a global flag that must come BEFORE the subcommand
    const args = ['-u', this.account, '-o', 'json', 'receive', '--timeout', String(timeoutSeconds)]

    const { stdout } = await execFileAsync(this.cliPath, args, {
      timeout: Math.max(30000, timeoutSeconds * 2000 + 25000),
      maxBuffer: 10 * 1024 * 1024,
    })

    const parsed = parseJsonObjects(stdout)
    return parsed
      .map((obj, index) => toSignalMessage(obj, this.account, index))
      .filter((msg): msg is SignalReceivedMessage => msg !== null)
  }
}

