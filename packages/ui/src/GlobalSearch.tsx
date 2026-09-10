"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { BudgetData, Query } from "@ynab/logic";
import { buildSearchIndex, payeeFacetOptions, searchBudget } from "@ynab/logic";
import { Icon, TextField, money } from "@ynab/theme";

export type GlobalSearchJump =
  | { kind: "transaction"; transactionId: number; accountId: number }
  | { kind: "payee"; payee: string }
  | { kind: "category"; categoryId: number }
  | { kind: "text"; text: string }
  | { kind: "query"; query: Query };

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

type FlatRow =
  | { key: string; kind: "payee"; payee: string }
  | { key: string; kind: "category"; categoryId: number }
  | { key: string; kind: "transaction"; transactionId: number; accountId: number };

export function GlobalSearch({
  data,
  scopeAccountId,
  onJump,
  className,
}: {
  data: BudgetData;
  scopeAccountId: number | null;
  onJump: (jump: GlobalSearchJump) => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [payeeFacet, setPayeeFacet] = useState("");
  const [categoryFacet, setCategoryFacet] = useState("");
  const [accountFacet, setAccountFacet] = useState("");
  const [searchAll, setSearchAll] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Debounce the keystrokes (perf on large registers), then defer the render
  // so typing never blocks the input even while the filtered list recomputes.
  const debouncedQuery = useDebouncedValue(query, 150);
  const deferredQuery = useDeferredValue(debouncedQuery);

  useEffect(() => {
    setSearchAll(false);
    setAccountFacet("");
  }, [scopeAccountId]);

  const index = useMemo(() => buildSearchIndex(data), [data]);
  const payeeOptions = useMemo(() => payeeFacetOptions(index), [index]);

  const results = useMemo(
    () =>
      searchBudget(
        index,
        {
          query: deferredQuery,
          payee: payeeFacet || null,
          categoryId: categoryFacet ? Number(categoryFacet) : null,
          accountId: accountFacet ? Number(accountFacet) : null,
        },
        { scopeAccountId, searchAll }
      ),
    [index, deferredQuery, payeeFacet, categoryFacet, accountFacet, scopeAccountId, searchAll]
  );

  const flat: FlatRow[] = useMemo(() => {
    const rows: FlatRow[] = [];
    for (const p of results.payees) rows.push({ key: `payee:${p.name}`, kind: "payee", payee: p.name });
    for (const c of results.categories)
      rows.push({ key: `cat:${c.id}`, kind: "category", categoryId: c.id });
    for (const t of results.transactions)
      rows.push({ key: `txn:${t.id}`, kind: "transaction", transactionId: t.id, accountId: t.accountId });
    return rows;
  }, [results]);

  useEffect(() => {
    setActive(0);
  }, [deferredQuery, payeeFacet, categoryFacet, accountFacet, searchAll, scopeAccountId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open ]);

  const commit = (row: FlatRow | undefined) => {
    if (!row) return;
    if (row.kind === "transaction") onJump({ kind: "transaction", transactionId: row.transactionId, accountId: row.accountId });
    else if (row.kind === "payee") onJump({ kind: "payee", payee: row.payee });
    else onJump({ kind: "category", categoryId: row.categoryId });
    setOpen(false);
    setQuery("");
  };

  const scopeName =
    scopeAccountId != null ? (data.accounts.find((a) => a.id === scopeAccountId)?.name ?? "") : "";
  const showAccountFacet = scopeAccountId == null || searchAll;

  const selectStyle: React.CSSProperties = { width: "100%", fontSize: 11, padding: "2px 4px" };

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className ?? ""}`} style={{ width: "100%" }} data-testid="global-search">
      <div className="flex min-w-0 items-center gap-1">
        <TextField
          search
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => (flat.length === 0 ? 0 : (a + 1) % flat.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (flat.length === 0 ? 0 : (a - 1 + flat.length) % flat.length));
            } else if (e.key === "Enter") {
              e.preventDefault();
              setOpen(true);
              commit(flat[active]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
          placeholder={scopeAccountId != null && !searchAll ? `Search ${scopeName || "this account"}…` : "Search all accounts…"}
          aria-label="Global search"
          style={{ flex: 1, minWidth: 0 }}
        />
        {(query || payeeFacet || categoryFacet || accountFacet) && (
          <button
            type="button"
            className="y-icon-btn"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              setPayeeFacet("");
              setCategoryFacet("");
              setAccountFacet("");
            }}
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {open && (
        <div
          role="listbox"
          aria-label="Search results"
          className="absolute z-50 overflow-auto"
          style={{
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            maxHeight: 380,
            background: "var(--y-row)",
            border: "1px solid var(--y-line)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
          }}
        >
          <div className="flex flex-col gap-1 px-2 py-1.5" style={{ borderBottom: "1px solid var(--y-line)" }}>
            {scopeAccountId != null && (
              <button
                type="button"
                className="y-btn y-btn--sm"
                aria-pressed={!searchAll}
                aria-label={searchAll ? "Searching all accounts" : `Searching ${scopeName || "this account"}`}
                onClick={() => setSearchAll((v) => !v)}
                style={{ width: "100%" }}
              >
                {searchAll ? "All accounts" : (scopeName ? `This account: ${scopeName}` : "This account")}
              </button>
            )}
            <select
              className="y-input"
              style={selectStyle}
              aria-label="Filter by payee"
              value={payeeFacet}
              onChange={(e) => setPayeeFacet(e.target.value)}
            >
              <option value="">Payee: all</option>
              {payeeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              className="y-input"
              style={selectStyle}
              aria-label="Filter by category"
              value={categoryFacet}
              onChange={(e) => setCategoryFacet(e.target.value)}
            >
              <option value="">Category: all</option>
              {data.groups.map((g) => (
                <optgroup key={g.id} label={g.name}>
                  {data.categories
                    .filter((c) => c.groupId === g.id)
                    .map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            {showAccountFacet && (
              <select
                className="y-input"
                style={selectStyle}
                aria-label="Filter by account"
                value={accountFacet}
                onChange={(e) => setAccountFacet(e.target.value)}
              >
                <option value="">Account: all</option>
                {data.accounts.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {flat.length === 0 && (
            <div className="px-3 py-2 text-[12px]" style={{ color: "var(--y-ink-soft)" }}>
              No matches
            </div>
          )}

          {results.payees.length > 0 && (
            <div>
              <div className="y-caps px-2 pt-1.5" style={{ fontSize: 10 }}>Payees</div>
              {results.payees.map((p) => {
                const idx = flat.findIndex((r) => r.key === `payee:${p.name}`);
                return (
                  <button
                    key={p.name}
                    type="button"
                    role="option"
                    aria-selected={idx === active}
                    className="flex w-full items-center justify-between px-2 py-1 text-left text-[12px]"
                    style={{ background: idx === active ? "var(--y-highlight, #eef4ff)" : "transparent" }}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => commit(flat[idx])}
                  >
                    <span className="truncate">{p.name}</span>
                    <span style={{ color: "var(--y-ink-soft)", fontSize: 11 }}>{p.txnCount} txns</span>
                  </button>
                );
              })}
            </div>
          )}

          {results.categories.length > 0 && (
            <div>
              <div className="y-caps px-2 pt-1.5" style={{ fontSize: 10 }}>Categories</div>
              {results.categories.map((c) => {
                const idx = flat.findIndex((r) => r.key === `cat:${c.id}`);
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={idx === active}
                    className="flex w-full items-center justify-between px-2 py-1 text-left text-[12px]"
                    style={{ background: idx === active ? "var(--y-highlight, #eef4ff)" : "transparent" }}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => commit(flat[idx])}
                  >
                    <span className="truncate">
                      {c.groupName ? `${c.groupName}: ` : ""}{c.name}
                    </span>
                    <span style={{ color: "var(--y-ink-soft)", fontSize: 11 }}>{c.txnCount} txns</span>
                  </button>
                );
              })}
            </div>
          )}

          {results.transactions.length > 0 && (
            <div>
              <div className="y-caps px-2 pt-1.5" style={{ fontSize: 10 }}>Transactions</div>
              {results.transactions.map((txn) => {
                const idx = flat.findIndex((r) => r.key === `txn:${txn.id}`);
                return (
                  <button
                    key={txn.id}
                    type="button"
                    role="option"
                    aria-selected={idx === active}
                    className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[12px]"
                    style={{ background: idx === active ? "var(--y-highlight, #eef4ff)" : "transparent" }}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => commit(flat[idx])}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{txn.payee || "(no payee)"}</span>
                      {txn.categoryName && (
                        <span style={{ color: "var(--y-ink-soft)" }}> · {txn.categoryName}</span>
                      )}
                      <span style={{ color: "var(--y-ink-soft)" }}> · {txn.accountName}</span>
                    </span>
                    <span className="shrink-0" style={{ color: "var(--y-ink-soft)", fontSize: 11 }}>
                      {txn.date}
                    </span>
                    <span className="shrink-0 tabular-nums">{money(txn.amount)}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="px-2 py-1 text-[11px]" style={{ color: "var(--y-ink-soft)" }}>
            Enter to jump · Esc to close
          </div>
        </div>
      )}
    </div>
  );
}
