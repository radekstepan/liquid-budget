"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BudgetData } from "@ynab/logic";
import {
  SEARCH_RECENTS_KEY,
  applyQuery,
  buildSearchCtx,
  buildSuggestions,
  deserializeQuery,
  filterFromRaw,
  filterId,
  filterLabel,
  KEYS,
  parseInput,
  resolveCategoryId,
  serializeQuery,
  type Filter,
  type FilterKey,
  type Item,
  type Query,
} from "@ynab/logic";
import { Icon, Kbd, Tooltip, cx, money } from "@ynab/theme";
import { Modal } from "./ui.js";
import type { GlobalSearchJump } from "./GlobalSearch.js";

const keyIcon: Record<FilterKey, string> = {
  payee: "wallet",
  category: "budget",
  account: "bank",
  amount: "chart",
  date: "calendar",
  memo: "note",
  is: "reconcile",
};

function loadRecents(): Query[] {
  try {
    const raw = localStorage.getItem(SEARCH_RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as (Query | string)[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => (typeof r === "string" ? deserializeQuery(r) : r))
      .filter((r) => r && (r.filters.length > 0 || r.text.trim().length > 0))
      .slice(0, 8);
  } catch {
    return [];
  }
}

function rawForFilter(f: Filter): string {
  switch (f.kind) {
    case "amount":
      return f.op === "between" ? `${f.a}..${f.b}` : f.op === "=" ? `${f.a}` : `${f.op}${f.a}`;
    case "date":
      return f.label;
    case "memo":
    case "payee":
    case "category":
    case "account":
    case "is":
      return f.value;
  }
}



export function GlobalSearchModal({
  data,
  scopeAccountId,
  open,
  onClose,
  onJump,
  initialQuery,
}: {
  data: BudgetData;
  scopeAccountId: number | null;
  open: boolean;
  onClose: () => void;
  onJump: (jump: GlobalSearchJump) => void;
  /** Pre-fill the input when editing an existing filter; blank start when null. */
  initialQuery?: Query | null;
}) {
  const [filters, setFilters] = useState<Filter[]>([]);
  const [ctxKey, setCtxKey] = useState<FilterKey | null>(null);
  const [input, setInput] = useState("");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<Query[]>([]);
  const [searchAll, setSearchAll] = useState(scopeAccountId == null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const ctx = useMemo(() => buildSearchCtx(data), [data]);

  // Reset per opening: seed from the query being edited (if any), else start
  // blank. Also refresh This-account scope and recents from storage.
  useEffect(() => {
    if (!open) return;
    setFilters(initialQuery?.filters ?? []);
    setCtxKey(null);
    setInput(initialQuery?.text ?? "");
    setActive(0);
    setSearchAll(scopeAccountId == null);
    setRecents(loadRecents());
  }, [open, scopeAccountId, initialQuery]);

  // Autofocus the input when the modal appears.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open ]);

  const fullInput = ctxKey ? `${ctxKey}:${input}` : input;
  const parsed = parseInput(fullInput);
  const draft = parsed.key ? filterFromRaw(parsed.key, parsed.value) : null;
  const effective: Query = useMemo(
    () => ({ filters: draft ? [...filters, draft] : filters, text: parsed.key ? "" : input }),
    [draft, filters, parsed.key, input]
  );

  const resultCount = useMemo(
    () =>
      applyQuery(data.transactions, effective, ctx, {
        scopeAccountId,
        searchAll,
      }).length,
    [data.transactions, effective, ctx, scopeAccountId, searchAll]
  );

  const groups = useMemo(
    () =>
      open
        ? buildSuggestions({
            input: fullInput,
            filters,
            data,
            ctx,
            recents,
            scopeAccountId,
            searchAll,
          })
        : [],
    [open, fullInput, filters, data, ctx, recents, scopeAccountId, searchAll]
  );
  const selectable = useMemo(
    () => groups.flatMap((g) => g.items).filter((i) => i.type !== "empty"),
    [groups]
  );

  useEffect(() => {
    setActive(0);
  }, [fullInput, filters, searchAll]);

  useEffect(() => {
    if (active >= selectable.length) setActive(Math.max(0, selectable.length - 1));
  }, [selectable.length, active]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    // scrollIntoView is unavailable in jsdom — guard so unit tests can run.
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, groups]);

  const saveRecent = useCallback((q: Query) => {
    if (!q.filters.length && !q.text.trim()) return;
    setRecents((prev) => {
      const key = serializeQuery(q);
      const next = [q, ...prev.filter((p) => serializeQuery(p) !== key)].slice(0, 8);
      try {
        localStorage.setItem(SEARCH_RECENTS_KEY, JSON.stringify(next));
      } catch {
        // Storage full or unavailable — recents are a nicety, never fatal.
      }
      return next;
    });
  }, []);

  const jumpAndClose = useCallback(
    (jump: GlobalSearchJump) => {
      onJump(jump);
      onClose();
    },
    [onJump, onClose]
  );

  const addChip = useCallback(
    (f: Filter) => {
      setFilters((prev) => (prev.some((x) => filterId(x) === filterId(f)) ? prev : [...prev, f]));
      setCtxKey(null);
      setInput("");
      saveRecent({ filters: [...filters, f], text: "" });
      inputRef.current?.focus();
    },
    [filters, saveRecent]
  );

  const removeFilter = useCallback((idx: number) => {
    setFilters((prev) => prev.filter((_, i) => i !== idx));
    inputRef.current?.focus();
  }, []);

  const editFilter = useCallback((idx: number) => {
    setFilters((prev) => {
      const f = prev[idx];
      if (!f) return prev;
      setCtxKey(f.kind);
      setInput(rawForFilter(f));
      return prev.filter((_, i) => i !== idx);
    });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const clearAll = useCallback(() => {
    setFilters([]);
    setCtxKey(null);
    setInput("");
    inputRef.current?.focus();
  }, []);

  const select = useCallback(
    (item: Item) => {
      switch (item.type) {
        case "key":
          setCtxKey(item.key);
          setInput("");
          inputRef.current?.focus();
          break;
        case "filter": {
          const f = item.filter;
          // Payee / resolvable-category picks jump straight to the register.
          if (f.kind === "payee" && f.exact) {
            saveRecent({ filters: [...filters, f], text: "" });
            jumpAndClose({ kind: "payee", payee: f.value });
            break;
          }
          if (f.kind === "category" && f.exact) {
            const id = resolveCategoryId(data, f.value);
            saveRecent({ filters: [...filters, f], text: "" });
            if (id != null) jumpAndClose({ kind: "category", categoryId: id });
            else jumpAndClose({ kind: "text", text: f.value });
            break;
          }
          addChip(f);
          break;
        }
        case "text": {
          // Carry the committed chips along so structured filters survive
          // the trip to the register instead of being silently dropped.
          const q = { filters, text: item.text };
          saveRecent(q);
          jumpAndClose({ kind: "query", query: q });
          break;
        }
        case "tx": {
          const t = item.tx;
          const targetAccountId = t.parentId != null
            ? (data.transactions.find((x) => x.id === t.parentId)?.accountId ?? t.accountId)
            : t.accountId;
          const targetId = t.parentId ?? t.id;
          jumpAndClose({ kind: "transaction", transactionId: targetId, accountId: targetAccountId });
          break;
        }
        case "recent":
          // Restore the recent query into the input so the user sees context.
          setFilters(item.query.filters);
          setCtxKey(null);
          setInput(item.query.text);
          inputRef.current?.focus();
          break;
      }
    },
    [addChip, data, filters, jumpAndClose, saveRecent]
  );

  const commitRaw = useCallback(() => {
    if (parsed.key) {
      const f = filterFromRaw(parsed.key, parsed.value);
      if (!f) return;
      if (f.kind === "payee" && f.exact !== true && parsed.value.trim()) {
        // Raw "payee:foo" without picking a suggestion = contains filter.
        addChip(f);
        return;
      }
      if (f.kind === "payee") {
        jumpAndClose({ kind: "payee", payee: f.value });
        return;
      }
      if (f.kind === "category") {
        const id = resolveCategoryId(data, f.value);
        if (id != null) jumpAndClose({ kind: "category", categoryId: id });
        else jumpAndClose({ kind: "text", text: f.value });
        return;
      }
      addChip(f);
      return;
    }
    if (input.trim()) {
      const q = { filters, text: input };
      saveRecent(q);
      jumpAndClose({ kind: "query", query: q });
    }
  }, [addChip, data, filters, input, jumpAndClose, parsed.key, parsed.value, saveRecent]);

  const handleChange = useCallback(
    (v: string) => {
      if (!ctxKey) {
        const p = parseInput(v);
        // Typing "payee:" converts to context mode with a dark key pill.
        if (p.key && /^[a-zA-Z]+:/.test(v)) {
          setCtxKey(p.key);
          setInput(p.value);
          return;
        }
      }
      setInput(v);
    },
    [ctxKey]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (selectable.length ? (a + 1) % selectable.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (selectable.length ? (a - 1 + selectable.length) % selectable.length : 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = selectable[active];
        if (item) select(item);
        else commitRaw();
      } else if (e.key === "Tab") {
        const item = selectable[active];
        if (item && (item.type === "key" || (item.type === "filter" && fullInput))) {
          e.preventDefault();
          select(item);
        }
      } else if (e.key === "Backspace" && input === "") {
        if (ctxKey) {
          e.preventDefault();
          // Drop the context pill and leave its name as editable text.
          setCtxKey(null);
          setInput(ctxKey);
        } else if (filters.length) {
          e.preventDefault();
          editFilter(filters.length - 1);
        }
      }
    },
    [active, commitRaw, ctxKey, editFilter, filters.length, fullInput, input, select, selectable]
  );

  if (!open) return null;

  const scopeName =
    scopeAccountId != null ? (data.accounts.find((a) => a.id === scopeAccountId)?.name ?? "") : "";
  const hasEffective = effective.filters.length > 0 || effective.text.trim().length > 0;
  let flatIndex = -1;

  return (
    <Modal title="Search" onClose={onClose} wide>
      <div data-testid="global-search-modal" className="flex flex-col gap-2">
        {scopeAccountId != null && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="y-btn y-btn--sm"
              aria-pressed={!searchAll}
              aria-label={searchAll ? "Searching all accounts" : `Searching ${scopeName || "this account"}`}
              onClick={() => setSearchAll((v) => !v)}
            >
              {searchAll ? "All accounts" : scopeName ? `This account: ${scopeName}` : "This account"}
            </button>
            <span className="text-[11px]" style={{ color: "var(--y-ink-soft)" }}>
              <Kbd>⌘K</Kbd> or <Kbd>/</Kbd> to reopen
            </span>
          </div>
        )}

        {/* Chip input */}
        <div
          onClick={() => inputRef.current?.focus()}
          className="y-searchbox flex min-h-[32px] w-full cursor-text flex-wrap items-center gap-1.5 px-1.5 py-1"
        >
          <Icon name="search" size={14} color="var(--y-ink-soft)" />
          {filters.map((f, i) => {
            const { key, value } = filterLabel(f);
            return (
              <span key={`${filterId(f)}:${i}`} className="y-chip">
                <Tooltip tip={`Edit ${key} filter`} className="flex h-full">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      editFilter(i);
                    }}
                    className="y-chip-edit"
                    aria-label={`Edit ${key} filter`}
                  >
                    <span className="y-chip-key">{key}</span>
                    <span className="y-chip-val">{value}</span>
                  </button>
                </Tooltip>
                <Tooltip tip={`Remove ${key} filter`} className="flex h-full">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFilter(i);
                    }}
                    className="y-chip-x"
                    aria-label={`Remove ${key} filter`}
                  >
                    <Icon name="x" size={10} />
                  </button>
                </Tooltip>
              </span>
            );
          })}
          {ctxKey && <span className="y-chip--key">{KEYS[ctxKey].label}</span>}
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              ctxKey
                ? KEYS[ctxKey].placeholder
                : filters.length
                  ? "Add another filter or search…"
                  : "Search transactions, or type payee: category: amount: …"
            }
            className="h-7 min-w-[8rem] flex-1 text-[14px]"
            style={{
              background: "transparent",
              border: "none",
              outline: "none",
              boxShadow: "none",
              padding: 0,
              color: "var(--y-ink)",
              fontFamily: "inherit",
            }}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded
            aria-controls="global-search-listbox"
            aria-autocomplete="list"
            aria-label="Search transactions"
            data-testid="global-search-input"
          />
          {(filters.length > 0 || input || ctxKey) && (
            <button
              type="button"
              className="y-icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                clearAll();
              }}
              aria-label="Clear search"
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>

        {/* Context banner */}
        {parsed.key && (
          <div
            className="flex items-center justify-between rounded px-2.5 py-1.5 text-[12px]"
            style={{
              background: "linear-gradient(var(--y-chrome-top), var(--y-chrome-bot))",
              border: "1px solid var(--y-chrome-line)",
              borderRadius: 3,
              color: "var(--y-ink-soft)",
            }}
          >
            <span>
              Filter by <strong style={{ color: "var(--y-ink)" }}>{KEYS[parsed.key].label.toLowerCase()}</strong>
              {parsed.value.trim() && " · previewing results live"}
            </span>
            <span className="font-mono text-[11px]">{KEYS[parsed.key].hint}</span>
          </div>
        )}

        {/* Results */}
        <div
          ref={listRef}
          id="global-search-listbox"
          role="listbox"
          aria-label="Search results"
          className="y-dropdown y-dropdown--inline y-scroll max-h-[24rem] overflow-y-auto py-1"
        >
          {groups.map((g) => (
            <div key={g.id} className="px-1 py-0.5">
              {g.title && (
                <div className="y-caps px-2 pb-0.5 pt-1.5" style={{ fontSize: 10 }}>
                  {g.title}
                </div>
              )}
              {g.items.map((item) => {
                const isSelectable = item.type !== "empty";
                if (isSelectable) flatIndex += 1;
                const idx = flatIndex;
                const isActive = isSelectable && idx === active;
                return (
                  <ResultRow
                    key={item.id}
                    item={item}
                    active={isActive}
                    ctx={ctx}
                    accountName={(id: number) =>
                      data.accounts.find((a) => a.id === id)?.name ?? ""
                    }
                    onHover={() => isSelectable && setActive(idx)}
                    onSelect={() => select(item)}
                  />
                );
              })}
            </div>
          ))}
          {groups.length === 0 && (
            <div className="px-3 py-4 text-[12px]" style={{ color: "var(--y-ink-soft)" }}>
              <div className="font-semibold" style={{ color: "var(--y-ink)" }}>
                {fullInput.trim() ? <>No matches for &ldquo;{fullInput.trim()}&rdquo;</> : "No matches"}
              </div>
              <div className="mt-1 leading-relaxed">
                Try fewer keywords, or narrow it down with{" "}
                <span className="font-mono">payee:</span>,{" "}
                <span className="font-mono">category:</span>,{" "}
                <span className="font-mono">account:</span>,{" "}
                <span className="font-mono">amount:</span> or{" "}
                <span className="font-mono">date:</span>.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-2 border-t pt-2 text-[11px]"
          style={{ borderColor: "var(--y-line)", color: "var(--y-ink-soft)" }}
        >
          <div className="flex items-center gap-2.5">
            <span>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span>
              <Kbd>↵</Kbd> select
            </span>
            <span>
              <Kbd>⇥</Kbd> complete
            </span>
            <span>
              <Kbd>esc</Kbd> close
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="tabular-nums">
              {resultCount.toLocaleString()} {resultCount === 1 ? "transaction" : "transactions"}
            </span>
            {hasEffective && (
              <Tooltip tip="Apply this search to the register filter">
                <button
                  type="button"
                  className="y-btn y-btn--sm"
                  onClick={() => {
                    saveRecent(effective);
                    jumpAndClose({ kind: "query", query: effective });
                  }}
                >
                  Show in register
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ResultRow({
  item,
  active,
  onHover,
  onSelect,
  accountName,
  ctx,
}: {
  item: Item;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
  accountName: (id: number) => string;
  ctx: { categoryById: Map<number, { name: string; groupName: string }> };
}) {
  if (item.type === "empty") {
    return (
      <div className="px-2 py-1.5 text-[12px]" style={{ color: "var(--y-ink-soft)" }}>
        {item.label}
      </div>
    );
  }

  const rowCls = cx("flex w-full items-center gap-2.5 rounded px-2 py-1 text-left text-[12px]");
  const rowStyle: React.CSSProperties = {
    background: active ? "var(--y-row-sel)" : "transparent",
    color: "var(--y-ink)",
  };
  const subStyle: React.CSSProperties = { color: "var(--y-ink-soft)" };
  const common = {
    role: "option" as const,
    "aria-selected": active,
    "data-active": active,
    onMouseMove: onHover,
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    onClick: onSelect,
    className: rowCls,
    style: rowStyle,
    type: "button" as const,
  };

  switch (item.type) {
    case "key":
      return (
        <button {...common}>
          <Icon name={keyIcon[item.key] as never} size={13} color="var(--y-ink-soft)" />
          <span className="font-medium">{item.label}</span>
          <span className="truncate text-[12px]" style={subStyle}>
            {item.hint}
          </span>
          <span className="ml-auto font-mono text-[11px]" style={subStyle}>
            {item.key}:
          </span>
        </button>
      );
    case "filter":
      return (
        <button {...common}>
          <Icon name={keyIcon[item.key] as never} size={13} color="var(--y-ink-soft)" />
          <span className="truncate font-medium">{item.label}</span>
          {item.sublabel && (
            <span className="truncate text-[12px]" style={subStyle}>
              {item.sublabel}
            </span>
          )}
          <span
            className="ml-auto rounded px-1.5 py-0.5 text-[11px] tabular-nums"
            style={{
              background: "linear-gradient(var(--y-chrome-top), var(--y-chrome-bot))",
              border: "1px solid var(--y-chrome-line)",
              ...subStyle,
            }}
          >
            {item.count}
          </span>
        </button>
      );
    case "text":
      return (
        <button {...common}>
          <Icon name="search" size={13} color="var(--y-ink-soft)" />
          <span className="truncate">
            Search everything for <span className="font-medium">“{item.label}”</span>
          </span>
          <span
            className="ml-auto rounded px-1.5 py-0.5 text-[11px] tabular-nums"
            style={{
              background: "linear-gradient(var(--y-chrome-top), var(--y-chrome-bot))",
              border: "1px solid var(--y-chrome-line)",
              ...subStyle,
            }}
          >
            {item.count}
          </span>
        </button>
      );
    case "recent":
      return (
        <button {...common}>
          <Icon name="clock" size={13} color="var(--y-ink-soft)" />
          <span className="truncate font-mono text-[12px]">{item.label}</span>
        </button>
      );
    case "tx": {
      const tx = item.tx;
      const cat = tx.categoryId != null ? ctx.categoryById.get(tx.categoryId) : undefined;
      const cents = Number(tx.amount) || 0;
      return (
        <button {...common}>
          <Icon name="transactions" size={13} color="var(--y-ink-soft)" />
          <span className="w-[86px] shrink-0 tabular-nums text-[12px]" style={subStyle}>
            {tx.date}
          </span>
          <span className="truncate font-medium">{tx.payee || "(no payee)"}</span>
          <span className="truncate text-[12px]" style={subStyle}>
            {cat ? `${cat.groupName ? `${cat.groupName}: ` : ""}${cat.name}` : tx.transferAccountId != null ? "Transfer" : "Uncategorized"}
            {tx.memo ? ` · ${tx.memo}` : ""}
          </span>
          <span
            className="ml-auto shrink-0 tabular-nums text-[12px]"
            style={{ color: cents > 0 ? "var(--y-green, #1a7f37)" : "var(--y-ink)" }}
          >
            {money(cents)}
          </span>
          <span className="w-20 shrink-0 truncate text-right text-[11px]" style={subStyle}>
            {accountName(tx.accountId)}
          </span>
        </button>
      );
    }
  }
}
