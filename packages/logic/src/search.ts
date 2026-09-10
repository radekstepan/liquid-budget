import type { BudgetData } from "./types.js";

export type SearchScope = { scopeAccountId: number | null; searchAll: boolean };

export type SearchFacets = {
  /** Free-text query matched against payee / memo / category / account. */
  query: string;
  /** Exact payee name facet (structured picker, not free text). */
  payee: string | null;
  /** Category id facet (structured picker). */
  categoryId: number | null;
  /** Account id facet — only used when searching all accounts. */
  accountId: number | null;
};

export type PayeeHit = { name: string; txnCount: number };
export type CategoryHit = { id: number; name: string; groupName: string; txnCount: number };
export type TransactionHit = {
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

export type SearchResults = {
  payees: PayeeHit[];
  categories: CategoryHit[];
  transactions: TransactionHit[];
};

type IndexedTxn = {
  id: number;
  accountId: number;
  transferAccountId: number | null;
  payee: string;
  payeeNorm: string;
  memo: string;
  memoNorm: string;
  categoryId: number | null;
  categoryNorm: string;
  accountNorm: string;
  date: string;
  amount: number;
};

export type SearchIndex = {
  txns: IndexedTxn[];
  accountById: Map<number, string>;
  categoryById: Map<number, { name: string; norm: string; groupName: string }>;
  payeeCounts: { name: string; norm: string; count: number }[];
  categoryCounts: Map<number, number>;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function rankMatch(haystack: string, needle: string): number {
  if (!needle) return 1;
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  if (haystack.includes(needle)) return 2;
  return -1;
}

export function buildSearchIndex(data: BudgetData): SearchIndex {
  const accountById = new Map<number, string>();
  for (const a of data.accounts) accountById.set(a.id, a.name);
  const groupById = new Map<number, string>();
  for (const g of data.groups) groupById.set(g.id, g.name);
  const categoryById = new Map<number, { name: string; norm: string; groupName: string }>();
  for (const c of data.categories) {
    categoryById.set(c.id, {
      name: c.name,
      norm: norm(c.name),
      groupName: groupById.get(c.groupId) ?? "",
    });
  }
  const txns: IndexedTxn[] = data.transactions.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    transferAccountId: t.transferAccountId ?? null,
    payee: t.payee,
    payeeNorm: norm(t.payee),
    memo: t.memo ?? "",
    memoNorm: norm(t.memo),
    categoryId: t.categoryId ?? null,
    categoryNorm: t.categoryId != null ? (categoryById.get(t.categoryId)?.norm ?? "") : "",
    accountNorm: norm(accountById.get(t.accountId) ?? ""),
    date: t.date,
    amount: Number(t.amount),
  }));
  const payeeMap = new Map<string, { name: string; count: number }>();
  for (const t of data.transactions) {
    const name = (t.payee || "").trim();
    if (!name || name.startsWith("Transfer : ")) continue;
    const key = name.toLowerCase();
    const prev = payeeMap.get(key);
    if (prev) prev.count++;
    else payeeMap.set(key, { name, count: 1 });
  }
  const payeeCounts = [...payeeMap.values()]
    .map((p) => ({ ...p, norm: norm(p.name) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const categoryCounts = new Map<number, number>();
  for (const t of data.transactions) {
    if (t.categoryId != null) categoryCounts.set(t.categoryId, (categoryCounts.get(t.categoryId) ?? 0) + 1);
  }
  return { txns, accountById, categoryById, payeeCounts, categoryCounts };
}

const MAX_PAYEES = 8;
const MAX_CATEGORIES = 8;
const MAX_TXNS = 30;

export function searchBudget(
  index: SearchIndex,
  facets: SearchFacets,
  scope: SearchScope
): SearchResults {
  const q = norm(facets.query);
  const payeeFacet = facets.payee ? norm(facets.payee) : null;
  const effectiveScopeAccount =
    scope.scopeAccountId != null && !scope.searchAll ? scope.scopeAccountId : null;
  // Explicit account facet wins over the scope toggle.
  const accountFacet = facets.accountId;

  const inScope = (t: IndexedTxn) => {
    if (accountFacet != null) return t.accountId === accountFacet || t.transferAccountId === accountFacet;
    if (effectiveScopeAccount != null) {
      return t.accountId === effectiveScopeAccount || t.transferAccountId === effectiveScopeAccount;
    }
    return true;
  };
  const matchesFacets = (t: IndexedTxn) => {
    if (!inScope(t)) return false;
    if (payeeFacet && t.payeeNorm !== payeeFacet) return false;
    if (facets.categoryId != null && t.categoryId !== facets.categoryId) return false;
    return true;
  };

  // Payee hits: structured facet source, ranked by query then usage.
  // Scoped like transactions so "This account" never suggests payees with
  // no transactions in scope.
  const scopedPayees = new Set<string>();
  const scopedCategories = new Set<number>();
  for (const t of index.txns) {
    if (!inScope(t)) continue;
    if (t.payeeNorm) scopedPayees.add(t.payeeNorm);
    if (t.categoryId != null) scopedCategories.add(t.categoryId);
  }
  const payees: PayeeHit[] = [];
  for (const p of index.payeeCounts) {
    if (!scopedPayees.has(p.norm)) continue;
    if (payeeFacet && p.norm !== payeeFacet) continue;
    if (q) {
      const r = rankMatch(p.norm, q);
      if (r < 0) continue;
    }
    payees.push({ name: p.name, txnCount: p.count });
    if (payees.length >= MAX_PAYEES && !q) break;
  }
  if (q) {
    payees.sort((a, b) => {
      const ra = rankMatch(norm(a.name), q);
      const rb = rankMatch(norm(b.name), q);
      return ra - rb || b.txnCount - a.txnCount;
    });
  }
  const payeeHits = payees.slice(0, MAX_PAYEES);

  // Category hits (scoped: only categories used in scope).
  const catHits: (CategoryHit & { rank: number })[] = [];
  for (const [id, c] of index.categoryById) {
    if (!scopedCategories.has(id)) continue;
    if (facets.categoryId != null && id !== facets.categoryId) continue;
    let rank = 0;
    if (q) {
      const rName = rankMatch(c.norm, q);
      const rGroup = rankMatch(norm(c.groupName), q);
      rank = rName >= 0 ? rName : rGroup >= 0 ? rGroup + 1 : -1;
      if (rank < 0) continue;
    }
    catHits.push({
      id,
      name: c.name,
      groupName: c.groupName,
      txnCount: index.categoryCounts.get(id) ?? 0,
      rank,
    });
  }
  catHits.sort((a, b) => a.rank - b.rank || b.txnCount - a.txnCount || a.name.localeCompare(b.name));
  const categories: CategoryHit[] = catHits
    .slice(0, MAX_CATEGORIES)
    .map(({ rank: _r, ...rest }) => rest);

  // Transaction hits.
  const txnHits: TransactionHit[] = [];
  const emptyQuery = !q && !payeeFacet && facets.categoryId == null && accountFacet == null;
  for (const t of index.txns) {
    if (!matchesFacets(t)) continue;
    let rank: number;
    if (emptyQuery) {
      rank = 0;
    } else if (!q) {
      rank = 0;
    } else {
      const ranks = [
        rankMatch(t.payeeNorm, q),
        rankMatch(t.memoNorm, q),
        rankMatch(t.categoryNorm, q),
        rankMatch(t.accountNorm, q),
      ].filter((r) => r >= 0);
      if (ranks.length === 0) continue;
      rank = Math.min(...ranks);
    }
    const cat = t.categoryId != null ? index.categoryById.get(t.categoryId) : undefined;
    txnHits.push({
      id: t.id,
      accountId: t.accountId,
      accountName: index.accountById.get(t.accountId) ?? "",
      payee: t.payee,
      memo: t.memo,
      categoryId: t.categoryId,
      categoryName: cat?.name ?? "",
      date: t.date,
      amount: t.amount,
      rank,
    });
  }
  txnHits.sort((a, b) => a.rank - b.rank || (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  return { payees: payeeHits, categories, transactions: txnHits.slice(0, MAX_TXNS) };
}

/** Distinct payee names for the structured payee picker, ordered by usage. */
export function payeeFacetOptions(index: SearchIndex): { value: string; label: string }[] {
  return index.payeeCounts.map((p) => ({ value: p.name, label: `${p.name} (${p.count})` }));
}
