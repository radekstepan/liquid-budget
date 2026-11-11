import { and, desc, eq, lt, or } from "drizzle-orm";
import { isValidISODate, TransactionError, type ClearedStatus } from "@ynab/logic";
import type { Db } from "../../client.js";
import { transactions } from "../../schema.js";
import { sanitizeFlagState } from "./validation.js";

/**
 * Cursor-paginated transaction reads (P1 pagination).
 *
 * `getBudgetData()` fans out to full-table SELECTs; the register on a
 * large budget should page through this instead. Keyset on
 * (date DESC, id DESC) — the same order the full dump uses — so pages
 * are stable under concurrent inserts (a new row lands on an earlier
 * page, never duplicated or skipped on later ones).
 */

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

type TransactionRow = typeof transactions.$inferSelect;

/**
 * Wire serialization shared with `getBudgetData()`. Keep this as the
 * single mapping so the paged rows can never drift from the full dump
 * (string money, sanitized flags, boolean coercions).
 */
export function serializeTransactionRow(t: TransactionRow) {
  return {
    ...t,
    amount: String(t.amount),
    status: (t.status as ClearedStatus) ?? "c",
    transferStatus: (t.transferStatus as ClearedStatus | null) ?? null,
    // createdAt is already a text string in SQLite
    createdAt: t.createdAt,
    isIncome: Boolean(t.isIncome),
    needsReview: Boolean(t.needsReview),
    reconciledAt: t.reconciledAt,
    reconciliationId: t.reconciliationId,
    transferReconciledAt: t.transferReconciledAt,
    transferReconciliationId: t.transferReconciliationId,
    // Sanitize any flag_color read from the DB so a rogue value never
    // reaches the UI. The internal "duplicate" marker is allowed here.
    flagColor: sanitizeFlagState(t.flagColor),
  };
}

export type SerializedTransaction = ReturnType<typeof serializeTransactionRow>;

/** Opaque keyset position: base64url JSON of the last row's (date, id). */
export function encodeTransactionCursor(date: string, id: number): string {
  return Buffer.from(JSON.stringify({ d: date, i: id }), "utf8").toString("base64url");
}

export function decodeTransactionCursor(cursor: unknown): { date: string; id: number } {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 1000) {
    throw new TransactionError("Invalid pagination cursor", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TransactionError("Invalid pagination cursor", 400);
  }
  const record = parsed as { d?: unknown; i?: unknown } | null;
  const date = typeof record?.d === "string" ? record.d : null;
  const id = typeof record?.i === "number" ? record.i : null;
  if (date === null || !isValidISODate(date) || id === null || !Number.isInteger(id) || id <= 0) {
    throw new TransactionError("Invalid pagination cursor", 400);
  }
  return { date, id };
}

export type ListTransactionsPageInput = {
  accountId?: number;
  /** Return rows strictly before this cursor (keyset). Omitted = first page. */
  before?: string;
  limit?: number;
};

export type TransactionsPage = {
  transactions: SerializedTransaction[];
  /** Pass as `before` for the next page; null when this page is the last. */
  nextCursor: string | null;
  hasMore: boolean;
};

export async function listTransactionsPage(db: Db, input: ListTransactionsPageInput): Promise<TransactionsPage> {
  const accountId = input.accountId;
  if (accountId !== undefined && (!Number.isInteger(accountId) || accountId <= 0)) {
    throw new TransactionError("Invalid accountId", 400);
  }
  const limit =
    input.limit === undefined
      ? DEFAULT_PAGE_LIMIT
      : Math.min(Math.max(Math.floor(input.limit), 1), MAX_PAGE_LIMIT);
  if (input.limit !== undefined && (!Number.isFinite(input.limit) || input.limit < 1)) {
    throw new TransactionError("limit must be a positive integer", 400);
  }

  const conditions = [];
  if (accountId !== undefined) {
    conditions.push(eq(transactions.accountId, accountId));
  }
  if (input.before !== undefined) {
    const { date, id } = decodeTransactionCursor(input.before);
    conditions.push(
      or(lt(transactions.date, date), and(eq(transactions.date, date), lt(transactions.id, id)))
    );
  }

  const rows = await db
    .select()
    .from(transactions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    transactions: page.map(serializeTransactionRow),
    nextCursor: hasMore && last ? encodeTransactionCursor(last.date, last.id) : null,
    hasMore,
  };
}
