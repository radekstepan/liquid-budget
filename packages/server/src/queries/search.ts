import { isValidISODate, TransactionError } from "@ynab/logic";
import type { Db } from "../client.js";

/**
 * Server-side global search (P1 search-perf).
 *
 * `buildSearchIndex()` in `@ynab/logic` scans every transaction in JS on
 * each load. On a 100k-transaction budget that index build plus per-keystroke
 * filtering dominates interaction latency. These queries push the same
 * matching into SQLite (`SELECT ... WHERE ... LIMIT`, ranked in the same
 * rank-then-date order as the client) so large budgets fetch O(limit) rows.
 * The pure-JS fns stay as the fallback for small budgets and offline use.
 *
 * Parity notes vs `search.ts`:
 * - Free text matches payee / memo / category name / account name with the
 *   same exact(0) / prefix(1) / substring(2) ranks; `LIKE ... ESCAPE '\'`
 *   keeps `%`/`_`/`\` literal so a query for `100%` never becomes a wildcard.
 * - Scope rule mirrors `inScope()`: the explicit account facet wins over the
 *   scope toggle, and transfer legs count (`transfer_account_id` matches).
 * - Payee hits skip `Transfer : ...` rows case-sensitively and empty payees,
 *   exactly like the client; `txnCount` is the GLOBAL count (not scoped).
 * - Category hits only cover categories used in scope; `txnCount` is global.
 * - FTS5 was deliberately not used: its tokenizer matches token prefixes
 *   only, so mid-token substrings the client matches would silently drop.
 */

export const DEFAULT_SEARCH_LIMIT = 30;
export const MAX_SEARCH_LIMIT = 100;
export const MAX_SEARCH_PAYEES = 8;
export const MAX_SEARCH_CATEGORIES = 8;
export const MAX_SEARCH_PAYEE_OPTIONS = 500;

export type SearchTransactionHit = {
  id: number;
  accountId: number;
  accountName: string;
  payee: string;
  memo: string;
  categoryId: number | null;
  categoryName: string;
  date: string;
  amount: number;
  rank: number;
};

export type SearchPayeeHit = { name: string; txnCount: number };
export type SearchCategoryHit = { id: number; name: string; groupName: string; txnCount: number };
export type SearchPayeeOption = { value: string; label: string };

export type SearchGlobalResult = {
  payees: SearchPayeeHit[];
  categories: SearchCategoryHit[];
  transactions: SearchTransactionHit[];
  payeeOptions: SearchPayeeOption[];
  /** Opaque cursor for the next page; null when this page is the last. */
  nextCursor: string | null;
  hasMore: boolean;
};

export type SearchGlobalInput = {
  /** Free-text query; empty means "no text filter" (rank 0 for every row). */
  query?: string;
  /** Exact payee name facet (case-insensitive, like the client norm). */
  payee?: string;
  categoryId?: number;
  /** Explicit account facet — wins over the scope toggle. */
  accountId?: number;
  scopeAccountId?: number;
  /** False means "this account only". Defaults to true. */
  searchAll?: boolean;
  limit?: number;
  /** Return rows strictly after this cursor (keyset). Omitted = first page. */
  before?: string;
};

/** Opaque keyset position: base64url JSON of the last row's (rank, date, id). */
export function encodeSearchCursor(rank: number, date: string, id: number): string {
  return Buffer.from(JSON.stringify({ r: rank, d: date, i: id }), "utf8").toString("base64url");
}

export function decodeSearchCursor(cursor: unknown): { rank: number; date: string; id: number } {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 1000) {
    throw new TransactionError("Invalid search cursor", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TransactionError("Invalid search cursor", 400);
  }
  const record = parsed as { r?: unknown; d?: unknown; i?: unknown } | null;
  const rank = typeof record?.r === "number" ? record.r : null;
  const date = typeof record?.d === "string" ? record.d : null;
  const id = typeof record?.i === "number" ? record.i : null;
  if (
    rank === null ||
    !Number.isInteger(rank) ||
    rank < 0 ||
    rank > 2 ||
    date === null ||
    !isValidISODate(date) ||
    id === null ||
    !Number.isInteger(id) ||
    id <= 0
  ) {
    throw new TransactionError("Invalid search cursor", 400);
  }
  return { rank, date, id };
}

/** Escape the LIKE metacharacters so the query stays literal. */
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function assertPositiveInt(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new TransactionError(`Invalid ${name}`, 400);
  }
}

type Scope = { clause: string; params: (string | number)[] };

/** Row-level scope predicate mirroring the client `inScope()` (account facet wins). */
function scopePredicate(input: SearchGlobalInput, alias = "t"): Scope {
  const effective =
    input.accountId ?? (input.searchAll === false ? (input.scopeAccountId ?? null) : null);
  if (effective == null) return { clause: "1 = 1", params: [] };
  return {
    clause: `(${alias}.account_id = ? OR ${alias}.transfer_account_id = ?)`,
    params: [effective, effective],
  };
}

type TextFilter = {
  /** `AND (...)` fragment (empty when the query is blank). */
  where: string;
  params: (string | number)[];
  /** Rank expression (literal `0` when the query is blank). */
  rankExpr: string;
  /** Normalized query ("" when blank). */
  qn: string;
};

/**
 * Text rank expression shared by SELECT / ORDER BY / keyset so every page
 * ranks identically: exact match 0, prefix 1, substring 2 (client `rankMatch`).
 */
function textFilter(qn: string): TextFilter {
  if (qn === "") {
    return { where: "", params: [], rankExpr: "0", qn };
  }
  const fields = [
    "lower(t.payee)",
    "lower(COALESCE(t.memo, ''))",
    "lower(COALESCE(c.name, ''))",
    "lower(COALESCE(a.name, ''))",
  ];
  const sub = `%${escapeLike(qn)}%`;
  const where =
    `AND (${fields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(" OR ")})`;
  const exact = fields.map((f) => `${f} = ?`).join(" OR ");
  const prefix = fields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(" OR ");
  const rankExpr = `(CASE WHEN (${exact}) THEN 0 WHEN (${prefix}) THEN 1 ELSE 2 END)`;
  return {
    where,
    params: [sub, sub, sub, sub],
    rankExpr,
    qn,
  };
}

function rankParams(qn: string): (string | number)[] {
  if (qn === "") return [];
  const pre = `${escapeLike(qn)}%`;
  return [qn, qn, qn, qn, pre, pre, pre, pre];
}

export async function searchGlobal(db: Db, input: SearchGlobalInput): Promise<SearchGlobalResult> {
  assertPositiveInt(input.categoryId, "categoryId");
  assertPositiveInt(input.accountId, "accountId");
  assertPositiveInt(input.scopeAccountId, "scopeAccountId");
  const limit =
    input.limit === undefined
      ? DEFAULT_SEARCH_LIMIT
      : Math.min(Math.max(Math.floor(input.limit), 1), MAX_SEARCH_LIMIT);
  if (input.limit !== undefined && (!Number.isFinite(input.limit) || input.limit < 1)) {
    throw new TransactionError("limit must be a positive integer", 400);
  }
  const qn = (input.query ?? "").trim().toLowerCase();
  if (qn.length > 200) {
    throw new TransactionError("Invalid query", 400);
  }
  const scope = scopePredicate(input);
  const text = textFilter(qn);

  const payeeClause =
    input.payee !== undefined && input.payee !== "" ? "AND lower(t.payee) = lower(?)" : "";
  const payeeParams: (string | number)[] = payeeClause ? [input.payee!] : [];
  const categoryClause = input.categoryId !== undefined ? "AND t.category_id = ?" : "";
  const categoryParams: (string | number)[] = categoryClause ? [input.categoryId!] : [];

  let keyset = "";
  let keysetParams: (string | number)[] = [];
  if (input.before !== undefined) {
    const { rank, date, id } = decodeSearchCursor(input.before);
    keyset =
      `AND (${text.rankExpr} > ? OR (${text.rankExpr} = ? ` +
      `AND (t.date < ? OR (t.date = ? AND t.id < ?))))`;
    keysetParams = [...rankParams(qn), rank, ...rankParams(qn), rank, date, date, id];
  }

  const txnRows = db.$client
    .prepare(
      `SELECT t.id AS id, t.account_id AS accountId, COALESCE(a.name, '') AS accountName,
              t.payee AS payee, COALESCE(t.memo, '') AS memo,
              t.category_id AS categoryId, COALESCE(c.name, '') AS categoryName,
              t.date AS date, t.amount AS amount, ${text.rankExpr} AS rank
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE ${scope.clause} ${payeeClause} ${categoryClause} ${text.where} ${keyset}
       ORDER BY rank ASC, t.date DESC, t.id DESC
       LIMIT ?`
    )
    .all(
      // Placeholder order follows the SQL text: SELECT rank, scope,
      // payee/category facets, text filter, keyset, LIMIT.
      ...rankParams(qn),
      ...scope.params,
      ...payeeParams,
      ...categoryParams,
      ...text.params,
      ...keysetParams,
      limit + 1
    ) as {
    id: number;
    accountId: number;
    accountName: string;
    payee: string;
    memo: string;
    categoryId: number | null;
    categoryName: string;
    date: string;
    amount: number;
    rank: number;
  }[];

  const hasMore = txnRows.length > limit;
  const page = hasMore ? txnRows.slice(0, limit) : txnRows;
  const last = page[page.length - 1];
  const transactions: SearchTransactionHit[] = page.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    accountName: r.accountName,
    payee: r.payee,
    memo: r.memo,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    date: r.date,
    amount: Number(r.amount),
    rank: Number(r.rank),
  }));

  // Payees: global counts + in-scope flag in one GROUP BY; the client ranks
  // in JS over the same (name, global count) pairs, so mirror that here.
  // Display casing follows a grouped row (payees are stored consistently in
  // practice); grouping, exclusion, and counts match the client exactly.
  const payeeRows = db.$client
    .prepare(
      `SELECT TRIM(t.payee) AS name, COUNT(*) AS txnCount,
              MAX(CASE WHEN ${scope.clause} THEN 1 ELSE 0 END) AS inScope
       FROM transactions t
       WHERE TRIM(t.payee) <> ''
         AND substr(TRIM(t.payee), 1, 11) <> 'Transfer : '
       GROUP BY lower(TRIM(t.payee))`
    )
    .all(...scope.params) as { name: string; txnCount: number; inScope: number }[];

  const rankMatch = (haystack: string, needle: string): number => {
    if (!needle) return 1;
    if (haystack === needle) return 0;
    if (haystack.startsWith(needle)) return 1;
    if (haystack.includes(needle)) return 2;
    return -1;
  };
  const payeeFacetNorm = (input.payee ?? "").trim().toLowerCase() || null;
  const payeeHits: (SearchPayeeHit & { rank: number })[] = [];
  for (const row of payeeRows) {
    if (!row.inScope) continue;
    const normName = row.name.toLowerCase();
    if (payeeFacetNorm && normName !== payeeFacetNorm) continue;
    let rank = 0;
    if (qn !== "") {
      rank = rankMatch(normName, qn);
      if (rank < 0) continue;
    }
    payeeHits.push({ name: row.name, txnCount: Number(row.txnCount), rank });
  }
  payeeHits.sort((a, b) => a.rank - b.rank || b.txnCount - a.txnCount || a.name.localeCompare(b.name));
  const payees: SearchPayeeHit[] = payeeHits
    .slice(0, MAX_SEARCH_PAYEES)
    .map(({ rank: _rank, ...rest }) => rest);

  const payeeOptions: SearchPayeeOption[] = [...payeeRows]
    .sort(
      (a, b) => Number(b.txnCount) - Number(a.txnCount) || a.name.localeCompare(b.name)
    )
    .slice(0, MAX_SEARCH_PAYEE_OPTIONS)
    .map((r) => ({ value: r.name, label: `${r.name} (${r.txnCount})` }));

  // Categories: global usage counts + in-scope flag; rank (name, then group)
  // in JS exactly like the client.
  const categoryRows = db.$client
    .prepare(
      `SELECT c.id AS id, c.name AS name, COALESCE(g.name, '') AS groupName,
              COUNT(t.id) AS txnCount,
              MAX(CASE WHEN t.id IS NOT NULL AND (${scope.clause}) THEN 1 ELSE 0 END) AS inScope
       FROM categories c
       LEFT JOIN category_groups g ON g.id = c.group_id
       LEFT JOIN transactions t ON t.category_id = c.id
       GROUP BY c.id`
    )
    .all(...scope.params) as {
    id: number;
    name: string;
    groupName: string;
    txnCount: number;
    inScope: number;
  }[];

  const catHits: (SearchCategoryHit & { rank: number })[] = [];
  for (const row of categoryRows) {
    if (!row.inScope) continue;
    if (input.categoryId !== undefined && row.id !== input.categoryId) continue;
    let rank = 0;
    if (qn !== "") {
      const rName = rankMatch(row.name.toLowerCase(), qn);
      const rGroup = rankMatch(row.groupName.toLowerCase(), qn);
      rank = rName >= 0 ? rName : rGroup >= 0 ? rGroup + 1 : -1;
      if (rank < 0) continue;
    }
    catHits.push({
      id: row.id,
      name: row.name,
      groupName: row.groupName,
      txnCount: Number(row.txnCount),
      rank,
    });
  }
  catHits.sort(
    (a, b) => a.rank - b.rank || b.txnCount - a.txnCount || a.name.localeCompare(b.name)
  );
  const categories: SearchCategoryHit[] = catHits
    .slice(0, MAX_SEARCH_CATEGORIES)
    .map(({ rank: _rank, ...rest }) => rest);

  return {
    payees,
    categories,
    transactions,
    payeeOptions,
    nextCursor: hasMore && last ? encodeSearchCursor(Number(last.rank), last.date, last.id) : null,
    hasMore,
  };
}
