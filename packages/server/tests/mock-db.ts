import { getTableName } from "drizzle-orm";
import { vi } from "vitest";
import type { Database } from "../../src/client.js";

export type CallLog = {
  op: "select" | "insert" | "update" | "delete" | "execute";
  table?: string;
  values?: unknown;
  where?: unknown;
  set?: unknown;
  orderBy?: unknown;
  sql?: string;
};

export interface MockDb {
  db: Database;
  calls: CallLog[];
  respondWith: (op: string, payload: unknown) => void;
  reset: () => void;
}

type Row = Record<string, unknown>;

interface Chain {
  from(table: unknown): Chain;
  where(w: unknown): Chain;
  orderBy(o: unknown): Chain;
  set(s: unknown): Chain;
  values(v: unknown): Chain;
  returning(): Promise<Row[]>;
  then<T>(resolve: (v: T) => void, reject?: (e: unknown) => void): Promise<void>;
}

function makeChain(
  log: CallLog[],
  responses: Map<string, unknown>,
  kind: "select" | "insert" | "update" | "delete",
  entry: CallLog
): Chain {
  const chain: Chain = {
    from(table) {
      entry.table = getTableName(table as never);
      return chain;
    },
    where(w) {
      entry.where = w;
      return chain;
    },
    orderBy(o) {
      entry.orderBy = o;
      return chain;
    },
    set(s) {
      entry.set = s;
      return chain;
    },
    values(v) {
      entry.values = v;
      return chain;
    },
    async returning() {
      const key = `${kind}:${entry.table ?? "?"}`;
      const fallback = `${kind}:*`;
      return (responses.get(key) ?? responses.get(fallback) ?? []) as Row[];
    },
    then(resolve, reject) {
      const key = `${kind}:${entry.table ?? "?"}`;
      const fallback = `${kind}:*`;
      const value = responses.get(key) ?? responses.get(fallback) ?? [];
      try {
        resolve(value as never);
      } catch (e) {
        if (reject) reject(e);
        else throw e;
      }
      return Promise.resolve();
    },
  };
  return chain;
}

export function createMockDb(): MockDb {
  const calls: CallLog[] = [];
  const responses = new Map<string, unknown>();

  const db = {
    select(_table?: unknown) {
      const entry: CallLog = { op: "select" };
      calls.push(entry);
      return makeChain(calls, responses, "select", entry);
    },
    insert(table: unknown) {
      const entry: CallLog = { op: "insert", table: getTableName(table as never) };
      calls.push(entry);
      return makeChain(calls, responses, "insert", entry);
    },
    update(table: unknown) {
      const entry: CallLog = { op: "update", table: getTableName(table as never) };
      calls.push(entry);
      return makeChain(calls, responses, "update", entry);
    },
    delete(table: unknown) {
      const entry: CallLog = { op: "delete", table: getTableName(table as never) };
      calls.push(entry);
      return makeChain(calls, responses, "delete", entry);
    },
    execute: vi.fn(async (sqlAst: unknown) => {
      const node = sqlAst as { queryChunks: Array<{ value: unknown; type: string }> };
      const parts: string[] = [];
      for (const c of node.queryChunks) {
        if (c.type === "text") parts.push(String(c.value));
      }
      const text = parts.join("");
      calls.push({ op: "execute", sql: text });
      return { rows: [{ count: "0" }] };
    }),
  } as unknown as Database;

  return {
    db,
    calls,
    respondWith(op, payload) {
      responses.set(op, payload);
    },
    reset() {
      calls.length = 0;
      responses.clear();
    },
  };
}
