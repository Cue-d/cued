import { Worker } from "node:worker_threads";
import type { CuedDatabase } from "./database.js";
import {
  type DbWorkerJobArgs,
  type DbWorkerJobName,
  type DbWorkerJobResult,
  type DbWorkerRequest,
  type DbWorkerResponse,
  runDbWorkerJob,
} from "./db-worker-jobs.js";

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000;

export interface DbWorker {
  run<Name extends DbWorkerJobName>(
    job: Name,
    ...args: DbWorkerJobArgs<Name>
  ): Promise<DbWorkerJobResult<Name>>;
  close(): Promise<void>;
}

/** Runs jobs on the caller's own connection and thread. For tests and as a fallback. */
export class InlineDbWorker implements DbWorker {
  constructor(private readonly db: CuedDatabase) {}

  async run<Name extends DbWorkerJobName>(
    job: Name,
    ...args: DbWorkerJobArgs<Name>
  ): Promise<DbWorkerJobResult<Name>> {
    const connections = {
      handle: () => this.db.sqliteHandle(),
      database: () => this.db,
    };
    return (await runDbWorkerJob(connections, { id: 0, job, args })) as DbWorkerJobResult<Name>;
  }

  async close(): Promise<void> {}
}

/** The worker thread itself failed (could not start, crashed), as opposed to a job erroring. */
export class DbWorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbWorkerUnavailableError";
  }
}

/**
 * Prefers the worker, but if the worker thread cannot run at all, finishes the job inline and
 * stays inline: slower responses beat a daemon that cannot answer reads.
 */
export class ResilientDbWorker implements DbWorker {
  private degraded = false;

  constructor(
    private readonly primary: DbWorker,
    private readonly fallback: DbWorker,
    private readonly onDegraded?: (error: Error) => void,
  ) {}

  async run<Name extends DbWorkerJobName>(
    job: Name,
    ...args: DbWorkerJobArgs<Name>
  ): Promise<DbWorkerJobResult<Name>> {
    if (!this.degraded) {
      try {
        return await this.primary.run(job, ...args);
      } catch (error) {
        if (!(error instanceof DbWorkerUnavailableError)) {
          throw error;
        }
        this.degraded = true;
        this.onDegraded?.(error);
      }
    }
    return this.fallback.run(job, ...args);
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.fallback.close()]);
  }
}

function defaultWorkerUrl(): URL {
  // Compiled output runs the .js sibling; under a TypeScript loader (tsx) run the source.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./db-worker-thread.${extension}`, import.meta.url);
}

/**
 * Runs jobs on a worker thread that owns its own connections to the database.
 *
 * The thread starts on first use and is torn down after sitting idle, so a quiet daemon does
 * not carry a second isolate. If the thread dies, in-flight jobs fail and the next job starts
 * a fresh one.
 */
export class ThreadDbWorker implements DbWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly dbPath: string,
    private readonly options: { workerUrl?: URL; idleTimeoutMs?: number } = {},
  ) {}

  run<Name extends DbWorkerJobName>(
    job: Name,
    ...args: DbWorkerJobArgs<Name>
  ): Promise<DbWorkerJobResult<Name>> {
    if (this.closed) {
      return Promise.reject(new Error("Database worker is closed"));
    }
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(
        new DbWorkerUnavailableError(error instanceof Error ? error.message : String(error)),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    return new Promise<DbWorkerJobResult<Name>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, job, args } satisfies DbWorkerRequest);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.terminate(new Error("Database worker is closed"));
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = new Worker(this.options.workerUrl ?? defaultWorkerUrl(), {
      workerData: { dbPath: this.dbPath },
    });
    // The daemon must be able to exit while a read is still running.
    worker.unref();
    worker.on("message", (response: DbWorkerResponse) => {
      const waiter = this.pending.get(response.id);
      if (!waiter) {
        return;
      }
      this.pending.delete(response.id);
      if (response.ok) {
        waiter.resolve(response.result);
      } else {
        waiter.reject(new Error(response.error));
      }
      this.armIdleTimer();
    });
    const onGone = (error: Error) => {
      if (this.worker === worker) {
        this.worker = null;
        this.failPending(error);
      }
    };
    worker.on("error", (error) =>
      onGone(new DbWorkerUnavailableError(`Database worker failed: ${error.message}`)),
    );
    worker.on("exit", (code) =>
      onGone(new DbWorkerUnavailableError(`Database worker exited with code ${code}`)),
    );
    this.worker = worker;
    return worker;
  }

  private armIdleTimer(): void {
    if (this.pending.size > 0 || this.closed) {
      return;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) {
        void this.terminate(new Error("Database worker idled out"));
      }
    }, this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  private failPending(error: Error): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private async terminate(reason: Error): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const worker = this.worker;
    this.worker = null;
    this.failPending(reason);
    await worker?.terminate();
  }
}
