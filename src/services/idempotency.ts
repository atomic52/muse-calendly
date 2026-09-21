import { ApiError } from "../lib/errors.js";
import type { Store } from "../store/types.js";

export interface ProducedResponse<T> {
  status: number;
  body: T;
}

export interface IdempotentResult<T> {
  replayed: boolean;
  status: number;
  body: T;
}

/**
 * Idempotent write execution. Agents retry; without this, a retried booking
 * creates a duplicate meeting. A per-key in-process lock prevents two concurrent
 * identical requests from both executing.
 */
export class IdempotencyService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly store: Store) {}

  async run<T>(
    connectionId: string,
    key: string,
    requestHash: string,
    produce: () => Promise<ProducedResponse<T>>,
  ): Promise<IdempotentResult<T>> {
    const lockKey = `${connectionId}::${key}`;
    return this.withLock(lockKey, async () => {
      const existing = await this.store.getIdempotency(connectionId, key);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ApiError(
            "conflict",
            "This Idempotency-Key was already used with a different request. Use a new key.",
          );
        }
        return { replayed: true, status: existing.status, body: existing.response as T };
      }
      const produced = await produce();
      await this.store.putIdempotency({
        connectionId,
        key,
        requestHash,
        status: produced.status,
        response: produced.body,
        createdAt: Date.now(),
      });
      return { replayed: false, ...produced };
    });
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const guard = run.catch(() => undefined);
    this.locks.set(key, guard);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === guard) this.locks.delete(key);
    }
  }
}
