import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import type { Database, Db } from "./client.js";

export class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.unlock();
      };
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.unlock();
        });
      });
    });
  }

  private unlock(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  isLocked(): boolean {
    return this.locked;
  }
}

const mutexMap = new WeakMap<object, AsyncMutex>();

export function getDbConnectionKey(db: Database | Db | object): object {
  if (!db || typeof db !== "object") return db as unknown as object;
  return ((db as any).$client ?? db) as object;
}

export function getDbMutex(db: Database | Db | object): AsyncMutex {
  const target = getDbConnectionKey(db);
  let mutex = mutexMap.get(target);
  if (!mutex) {
    mutex = new AsyncMutex();
    mutexMap.set(target, mutex);
  }
  return mutex;
}

interface TxContext {
  connectionKey: object;
  depth: number;
}

const txStorage = new AsyncLocalStorage<TxContext>();

/**
 * Execute an asynchronous operation inside a serialized database transaction.
 *
 * - Acquires a connection-level `AsyncMutex` for the outer transaction so concurrent
 *   requests sharing the same SQLite connection do not interleave statements or
 *   trigger nested `BEGIN` errors.
 * - Supports re-entrancy / nested transactions within the same async context by
 *   creating SQLite `SAVEPOINT`s (`sp_<depth>`).
 * - Handles `COMMIT` / `ROLLBACK` (or `RELEASE` / `ROLLBACK TO` savepoints) automatically.
 */
export async function withTransaction<T>(
  db: Database | Db,
  fn: (db: Database) => Promise<T> | T
): Promise<T> {
  const connectionKey = getDbConnectionKey(db);
  const currentContext = txStorage.getStore();

  // If we are already within a transaction on this connection in the current async execution chain,
  // handle it as a nested transaction via SQLite savepoints.
  if (currentContext && currentContext.connectionKey === connectionKey) {
    const depth = currentContext.depth + 1;
    const savepointName = `sp_${depth}`;
    const nextContext: TxContext = { connectionKey, depth };

    db.run(sql.raw(`SAVEPOINT ${savepointName}`));
    try {
      const result = await txStorage.run(nextContext, () => fn(db as Database));
      db.run(sql.raw(`RELEASE SAVEPOINT ${savepointName}`));
      return result;
    } catch (err) {
      try {
        db.run(sql.raw(`ROLLBACK TO SAVEPOINT ${savepointName}`));
        db.run(sql.raw(`RELEASE SAVEPOINT ${savepointName}`));
      } catch {
        // preserve original error
      }
      throw err;
    }
  }

  // Outermost transaction: acquire the connection mutex to prevent concurrent async operations
  // from interleaving statements or beginning transactions on this connection.
  const mutex = getDbMutex(connectionKey);
  const releaseLock = await mutex.acquire();

  try {
    db.run(sql`BEGIN`);
    const context: TxContext = { connectionKey, depth: 1 };
    try {
      const result = await txStorage.run(context, () => fn(db as Database));
      db.run(sql`COMMIT`);
      return result;
    } catch (err) {
      try {
        db.run(sql`ROLLBACK`);
      } catch {
        // preserve original error
      }
      throw err;
    }
  } finally {
    releaseLock();
  }
}
