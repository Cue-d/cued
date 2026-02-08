/**
 * Signal CLI JSON-RPC daemon.
 *
 * Spawns a persistent `signal-cli jsonRpc` subprocess that receives messages
 * in real-time via stdout notifications and accepts requests via stdin.
 * Modeled after LinkedIn's RealtimeConnection reconnect pattern.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { toSignalMessage, type SignalReceivedMessage } from './client'

const MAX_RECONNECT_ATTEMPTS = 50
const MAX_BACKOFF_SECONDS = 60
const REQUEST_TIMEOUT_MS = 30_000

export interface SignalDaemonHandlers {
  onMessage?: (message: SignalReceivedMessage) => void
  onConnected?: () => void
  onDisconnected?: (error?: Error) => void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timeout: NodeJS.Timeout
}

interface JsonRpcResponse {
  jsonrpc: string
  id?: number
  method?: string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
  params?: unknown
}

export class SignalDaemon {
  private readonly account: string
  private readonly cliPath: string
  private readonly handlers: SignalDaemonHandlers

  private process: ChildProcess | null = null
  private readline: ReadlineInterface | null = null
  private nextRequestId = 1
  private pendingRequests = new Map<number, PendingRequest>()
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private shouldReconnect = true
  private connected = false
  private messageIndex = 0

  constructor(account: string, cliPath: string, handlers: SignalDaemonHandlers) {
    this.account = account
    this.cliPath = cliPath
    this.handlers = handlers
  }

  isConnected(): boolean {
    return this.connected
  }

  start(): void {
    this.shouldReconnect = true
    this.reconnectAttempts = 0
    this.spawn()
  }

  stop(): void {
    this.shouldReconnect = false
    this.cleanup()
  }

  async request<T>(method: string, params: object = {}): Promise<T> {
    if (!this.process?.stdin?.writable) {
      throw new Error('Daemon not connected')
    }

    const id = this.nextRequestId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      })

      this.process!.stdin!.write(payload, (err) => {
        if (err) {
          clearTimeout(timeout)
          this.pendingRequests.delete(id)
          reject(new Error(`Failed to write to daemon stdin: ${err.message}`))
        }
      })
    })
  }

  private spawn(): void {
    if (this.process) {
      this.cleanup()
    }

    const args = ['-u', this.account, '-o', 'json', 'jsonRpc']
    console.log(`[SignalDaemon] Spawning: ${this.cliPath} ${args.join(' ')}`)

    const proc = spawn(this.cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    this.process = proc

    // Read stdout line-by-line for JSON-RPC messages
    this.readline = createInterface({ input: proc.stdout! })
    this.readline.on('line', (line) => this.handleLine(line))

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) {
        console.warn(`[SignalDaemon] stderr: ${text}`)
      }
    })

    proc.on('error', (err) => {
      console.error(`[SignalDaemon] Process error: ${err.message}`)
      this.handleExit(err)
    })

    proc.on('exit', (code, signal) => {
      console.log(`[SignalDaemon] Process exited (code=${code}, signal=${signal})`)
      const exitError = code != null && code !== 0
        ? new Error(`Exited with code ${code}`)
        : undefined
      this.handleExit(exitError)
    })

    // Consider connected once the process is spawned successfully
    this.connected = true
    this.reconnectAttempts = 0
    this.handlers.onConnected?.()
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('{')) return

    let msg: JsonRpcResponse
    try {
      msg = JSON.parse(trimmed) as JsonRpcResponse
    } catch (err) {
      console.warn('[SignalDaemon] Failed to parse JSON-RPC line:', (err as Error).message)
      return
    }

    // Response to a request (has `id`)
    if (msg.id != null) {
      const pending = this.pendingRequests.get(msg.id)
      if (pending) {
        this.pendingRequests.delete(msg.id)
        clearTimeout(pending.timeout)
        if (msg.error) {
          pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // Notification (no `id`) — real-time message delivery
    if (msg.method === 'receive' && msg.params) {
      const parsed = toSignalMessage(msg.params, this.account, this.messageIndex++)
      if (parsed) {
        this.handlers.onMessage?.(parsed)
      }
    }
  }

  private handleExit(error?: Error): void {
    const wasConnected = this.connected
    this.connected = false
    this.readline?.close()
    this.readline = null
    this.process = null

    this.rejectAllPending('Daemon process exited')

    if (wasConnected) {
      this.handlers.onDisconnected?.(error)
    }

    // Guard on wasConnected to prevent double-reconnect when both error+exit fire
    if (this.shouldReconnect && wasConnected) {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[SignalDaemon] Max reconnect attempts reached')
      this.handlers.onDisconnected?.(new Error('Max reconnect attempts reached'))
      return
    }

    const backoffSeconds = Math.min(this.reconnectAttempts * 2, MAX_BACKOFF_SECONDS)
    console.log(
      `[SignalDaemon] Reconnecting in ${backoffSeconds}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.shouldReconnect) {
        this.spawn()
      }
    }, backoffSeconds * 1000)
  }

  private cleanup(): void {
    this.connected = false

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.readline?.close()
    this.readline = null

    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }

    this.rejectAllPending('Daemon stopped')
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(reason))
      this.pendingRequests.delete(id)
    }
  }
}
