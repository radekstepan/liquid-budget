import type { Account, BudgetData, Transaction } from "./types.js";
import { fmt } from "./format.js";

// ---------- types ----------

export type FilterKey = "payee" | "category" | "account" | "amount" | "date" | "memo" | "is";
export type AmountOp = ">" | "<" | ">=" | "<=" | "=" | "between";
export type StatusValue =
  | "cleared"
  | "uncleared"
  | "flagged"
  | "inflow"
  | "outflow"
  | "transfer"
  | "uncategorized";

export type Filter =
  | { kind: "payee"; value: string; exact?: boolean }
  | { kind: "category"; value: string; exact?: boolean }
  | { kind: "account"; value: string; exact?: boolean }
  | { kind: "memo"; value: string }
  | { kind: "amount"; op: AmountOp; a: number; b?: number }
  | { kind: "date"; start: string; end: string; label: string }
  | { kind: "is"; value: StatusValue };

export type Query = { filters: Filter[]; text: string };

export const SEARCH_RECENTS_KEY = "ynab-search-recents-v1";

export const KEYS: Record<FilterKey, { label: string; hint: string; placeholder: string }> = {
  payee: {
    label: "Payee",
    hint: "Who the money went to or came from",
    placeholder: "Type a payee name…",
  },
  category: {
    label: "Category",
    hint: "Budget category or group",
    placeholder: "Type a category…",
  },
  account: {
    label: "Account",
    hint: "Checking, savings, credit card…",
    placeholder: "Type an account…",
  },
  amount: {
    label: "Amount",
    hint: ">50   <20   =12.99   10..50",
    placeholder: "e.g. >50 or 10..50",
  },
  date: {
    label: "Date",
    hint: "this month, last 30 days, 2025-03",
    placeholder: "this month, last 30 days, 2025-03…",
  },
  memo: { label: "Memo", hint: "Words in the memo field", placeholder: "Words in the memo…" },
  is: {
    label: "Status",
    hint: "cleared, flagged, inflow, transfer…",
    placeholder: "cleared, uncleared, flagged…",
  },
};

export const KEY_ORDER: FilterKey[] = [
  "payee",
  "category",
  "account",
  "amount",
  "date",
  "memo",
  "is",
];

const KEY_ALIASES: Record<string, FilterKey> = {
  payee: "payee",
  payees: "payee",
  to: "payee",
  from: "payee",
  category: "category",
  cat: "category",
  categories: "category",
  account: "account",
  acct: "account",
  in: "account",
  amount: "amount",
  amt: "amount",
  date: "date",
  when: "date",
  memo: "memo",
  note: "memo",
  is: "is",
  status: "is",
};

export const STATUS_OPTIONS: { value: StatusValue; label: string; hint: string }[] = [
  { value: "uncleared", label: "Uncleared", hint: "Not yet cleared with the bank" },
  { value: "cleared", label: "Cleared", hint: "Cleared or reconciled" },
  { value: "flagged", label: "Flagged", hint: "Has a colour flag" },
  { value: "outflow", label: "Outflow", hint: "Money going out" },
  { value: "inflow", label: "Inflow", hint: "Money coming in" },
  { value: "transfer", label: "Transfer", hint: "Between your accounts" },
  { value: "uncategorized", label: "Uncategorized", hint: "Needs a category" },
];

// ---------- input parsing ----------

export type ParsedInput = { key: FilterKey | null; value: string; raw: string };

export function parseInput(raw: string): ParsedInput {
  const m = /^([a-zA-Z]+):(.*)$/.exec(raw);
  if (m) {
    const key = KEY_ALIASES[m[1]!.toLowerCase()];
    if (key) return { key, value: m[2]!.replace(/^\s+/, ""), raw };
  }
  if (/^\s*[<>=]/.test(raw)) return { key: "amount", value: raw.trim(), raw };
  return { key: null, value: raw, raw };
}

// ---------- amount (dollars in, cents compare) ----------

export function parseSearchAmount(input: string): Extract<Filter, { kind: "amount" }> | null {
  const s = input.replace(/[$,\s]/g, "").replace(/^~/, "");
  if (!s) return null;
  const range = /^(\d+(?:\.\d+)?)(?:\.\.|-|to)(\d+(?:\.\d+)?)$/.exec(s);
  if (range) {
    const a = parseFloat(range[1]!);
    const b = parseFloat(range[2]!);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { kind: "amount", op: "between", a: Math.min(a, b), b: Math.max(a, b) };
  }
  const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const a = parseFloat(m[2]!);
  if (!Number.isFinite(a)) return null;
  return { kind: "amount", op: (m[1] as AmountOp) || "=", a };
}

export function amountLabel(f: Extract<Filter, { kind: "amount" }>): string {
  const cents = (d: number) => Math.round(d * 100);
  if (f.op === "between") return `${fmt(cents(f.a))} – ${fmt(cents(f.b ?? f.a))}`;
  if (f.op === "=") return fmt(cents(f.a));
  return `${f.op} ${fmt(cents(f.a))}`;
}

// ---------- dates ----------

export type DateRange = { start: string; end: string; label: string };

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = (r.getDay() + 6) % 7; // monday start
  r.setDate(r.getDate() - day);
  return r;
}

export function datePresets(now = new Date()): { id: string; label: string; range: DateRange }[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d;
  };
  const y = today.getFullYear();
  const mth = today.getMonth();
  const mk = (id: string, label: string, s: Date, e: Date) => ({
    id,
    label,
    range: { start: toISODate(s), end: toISODate(e), label },
  });
  return [
    mk("today", "Today", today, today),
    mk("yesterday", "Yesterday", daysAgo(1), daysAgo(1)),
    mk("this-week", "This week", startOfWeek(today), today),
    mk("last-7", "Last 7 days", daysAgo(6), today),
    mk("this-month", "This month", new Date(y, mth, 1), new Date(y, mth + 1, 0)),
    mk("last-month", "Last month", new Date(y, mth - 1, 1), new Date(y, mth, 0)),
    mk("last-30", "Last 30 days", daysAgo(29), today),
    mk("last-90", "Last 90 days", daysAgo(89), today),
    mk("this-year", "This year", new Date(y, 0, 1), new Date(y, 11, 31)),
    mk("last-year", "Last year", new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)),
  ];
}

const normKey = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

export function parseSearchDate(input: string, now = new Date()): DateRange | null {
  const s = input.trim();
  if (!s) return null;
  const n = normKey(s);
  const preset = datePresets(now).find(
    (p) => normKey(p.id) === n || normKey(p.label) === n || normKey(p.label).replace("days", "") === n
  );
  if (preset) return preset.range;

  let m = /^(\d{4})$/.exec(s);
  if (m) return { start: `${m[1]}-01-01`, end: `${m[1]}-12-31`, label: m[1]! };

  m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return monthRange(Number(m[1]), Number(m[2]) - 1);

  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(d.getTime())) return null;
    const iso = toISODate(d);
    return {
      start: iso,
      end: iso,
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    };
  }

  m = /^([a-zA-Z]{3,})\s*(\d{4})?$/.exec(s);
  if (m) {
    const idx = MONTHS.findIndex((name) => name.startsWith(m![1]!.toLowerCase()));
    if (idx >= 0) {
      const y = m[2] ? Number(m[2]) : now.getMonth() >= idx ? now.getFullYear() : now.getFullYear() - 1;
      return monthRange(y, idx);
    }
  }
  return null;
}

function monthRange(y: number, m: number): DateRange | null {
  if (m < 0 || m > 11) return null;
  const s = new Date(y, m, 1);
  const e = new Date(y, m + 1, 0);
  return {
    start: toISODate(s),
    end: toISODate(e),
    label: s.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
  };
}

// ---------- building filters from raw text ----------

export function filterFromRaw(key: FilterKey, value: string): Filter | null {
  const v = value.trim();
  if (!v) return null;
  switch (key) {
    case "payee":
    case "category":
    case "account":
      return { kind: key, value: v };
    case "memo":
      return { kind: "memo", value: v };
    case "amount":
      return parseSearchAmount(v);
    case "date": {
      const r = parseSearchDate(v);
      return r ? { kind: "date", ...r } : null;
    }
    case "is": {
      const opt = STATUS_OPTIONS.find(
        (o) => o.value === v.toLowerCase() || o.label.toLowerCase() === v.toLowerCase()
      );
      return opt ? { kind: "is", value: opt.value } : null;
    }
  }
}

export function filterLabel(f: Filter): { key: string; value: string } {
  switch (f.kind) {
    case "payee":
      return { key: "Payee", value: f.value };
    case "category":
      return { key: "Category", value: f.value };
    case "account":
      return { key: "Account", value: f.value };
    case "memo":
      return { key: "Memo", value: `“${f.value}”` };
    case "amount":
      return { key: "Amount", value: amountLabel(f) };
    case "date":
      return { key: "Date", value: f.label };
    case "is":
      return { key: "Is", value: STATUS_OPTIONS.find((o) => o.value === f.value)?.label ?? f.value };
  }
}

export function filterId(f: Filter): string {
  return JSON.stringify(f);
}

export function serializeQuery(q: Query): string {
  const parts = q.filters.map((f) => {
    const { key, value } = filterLabel(f);
    return `${key.toLowerCase()}:${/\s/.test(value) ? `"${value}"` : value}`;
  });
  if (q.text.trim()) parts.push(q.text.trim());
  return parts.join(" ");
}

/** Strip serialization quotes so a recent query can repopulate chips + input. */
export function deserializeQuery(s: string): Query {
  const filters: Filter[] = [];
  const textParts: string[] = [];
  const re = /([a-z]+):(?:"([^"]+)"|(\S+))/gi;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  // Collect plain-text gaps between key:value tokens.
  const gaps: string[] = [];
  while ((m = re.exec(s)) !== null) {
    gaps.push(s.slice(lastIndex, m.index));
    lastIndex = m.index + m[0].length;
    const alias = m[1]!.toLowerCase();
    const rawValue = (m[2] ?? m[3] ?? "").trim();
    const key: FilterKey | undefined =
      alias === "payee"
        ? "payee"
        : alias === "category" || alias === "cat"
          ? "category"
          : alias === "account" || alias === "acct"
            ? "account"
            : alias === "amount" || alias === "amt"
              ? "amount"
              : alias === "date" || alias === "when"
                ? "date"
                : alias === "memo" || alias === "note"
                  ? "memo"
                  : alias === "is" || alias === "status"
                    ? "is"
                    : undefined;
    if (key) {
      // Memo values keep their quotes in the label; strip them for the chip.
      const v = rawValue.replace(/^“|”$/g, "");
      const f = filterFromRaw(key, v);
      if (f) filters.push(f);
    } else {
      textParts.push(m[0]);
    }
  }
  gaps.push(s.slice(lastIndex));
  const gapText = gaps.join(" ").trim();
  if (gapText) textParts.unshift(gapText);
  return { filters, text: textParts.join(" ").trim() };
}

// ---------- matching ----------

export type SearchCtx = {
  accountById: Map<number, string>;
  categoryById: Map<number, { name: string; groupName: string }>;
};

export function buildSearchCtx(data: BudgetData): SearchCtx {
  const accountById = new Map<number, string>();
  for (const a of data.accounts) accountById.set(a.id, a.name);
  const groupById = new Map<number, string>();
  for (const g of data.groups) groupById.set(g.id, g.name);
  const categoryById = new Map<number, { name: string; groupName: string }>();
  for (const c of data.categories) {
    categoryById.set(c.id, { name: c.name, groupName: groupById.get(c.groupId) ?? "" });
  }
  return { accountById, categoryById };
}

type Fields = {
  payee: string;
  memo: string;
  cat: string;
  master: string;
  acct: string;
  hay: string;
};

const txCache = new WeakMap<Transaction, Fields>();

function fields(tx: Transaction, ctx: SearchCtx): Fields {
  const cached = txCache.get(tx);
  if (cached) return cached;
  const cat = tx.categoryId != null ? ctx.categoryById.get(tx.categoryId) : undefined;
  const acct = ctx.accountById.get(tx.accountId) ?? "";
  const payee = (tx.payee ?? "").toLowerCase();
  const memo = (tx.memo ?? "").toLowerCase();
  const isTransfer = tx.transferAccountId != null;
  const catName = cat ? cat.name.toLowerCase() : isTransfer ? "" : "uncategorized";
  const master = cat ? cat.groupName.toLowerCase() : "";
  const acctName = acct.toLowerCase();
  const cents = Math.abs(Number(tx.amount) || 0);
  const c: Fields = {
    payee,
    memo,
    cat: catName,
    master,
    acct: acctName,
    hay: [payee, memo, catName, master, acctName, (cents / 100).toFixed(2), tx.date].join(" "),
  };
  txCache.set(tx, c);
  return c;
}

function textMatch(actual: string, wanted: string, exact?: boolean): boolean {
  const w = wanted.toLowerCase();
  return exact ? actual === w : actual.includes(w);
}

export function matchesFilter(tx: Transaction, f: Filter, ctx: SearchCtx): boolean {
  const c = fields(tx, ctx);
  switch (f.kind) {
    case "payee":
      return textMatch(c.payee, f.value, f.exact);
    case "category":
      return textMatch(c.cat, f.value, f.exact) || textMatch(c.master, f.value, f.exact);
    case "account":
      return textMatch(c.acct, f.value, f.exact);
    case "memo":
      return c.memo.includes(f.value.toLowerCase());
    case "amount": {
      const vCents = Math.abs(Number(tx.amount) || 0);
      const aCents = Math.round(f.a * 100);
      const bCents = f.b != null ? Math.round(f.b * 100) : aCents;
      switch (f.op) {
        case ">":
          return vCents > aCents;
        case "<":
          return vCents < aCents;
        case ">=":
          return vCents >= aCents;
        case "<=":
          return vCents <= aCents;
        case "=":
          return vCents === aCents;
        case "between":
          return vCents >= Math.min(aCents, bCents) && vCents <= Math.max(aCents, bCents);
      }
      break;
    }
    case "date":
      return tx.date >= f.start && tx.date <= f.end;
    case "is": {
      const cents = Number(tx.amount) || 0;
      switch (f.value) {
        case "cleared":
          return tx.status === "c" || tx.status === "r";
        case "uncleared":
          return tx.status === "u";
        case "flagged":
          return tx.flagColor != null && tx.flagColor !== "duplicate";
        case "inflow":
          return cents > 0;
        case "outflow":
          return cents < 0;
        case "transfer":
          return tx.transferAccountId != null;
        case "uncategorized":
          return tx.categoryId == null && tx.transferAccountId == null;
      }
      break;
    }
  }
  return true;
}

export function textTokens(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesText(tx: Transaction, tokens: string[], ctx: SearchCtx): boolean {
  if (tokens.length === 0) return true;
  const hay = fields(tx, ctx).hay;
  return tokens.every((t) => hay.includes(t));
}

export function inScope(
  tx: Transaction,
  scopeAccountId: number | null,
  searchAll: boolean,
  accountFacet: number | null
): boolean {
  if (accountFacet != null) {
    return tx.accountId === accountFacet || tx.transferAccountId === accountFacet;
  }
  if (scopeAccountId != null && !searchAll) {
    return tx.accountId === scopeAccountId || tx.transferAccountId === scopeAccountId;
  }
  return true;
}

export function applyQuery(
  txs: Transaction[],
  q: Query,
  ctx: SearchCtx,
  scope?: { scopeAccountId?: number | null; searchAll?: boolean; accountId?: number | null }
): Transaction[] {
  const tokens = textTokens(q.text);
  return txs.filter(
    (tx) =>
      (!scope || inScope(tx, scope.scopeAccountId ?? null, scope.searchAll ?? true, scope.accountId ?? null)) &&
      q.filters.every((f) => matchesFilter(tx, f, ctx)) &&
      matchesText(tx, tokens, ctx)
  );
}

// ---------- suggestions ----------

export type Item =
  | { id: string; type: "key"; key: FilterKey; label: string; hint: string }
  | {
      id: string;
      type: "filter";
      key: FilterKey;
      filter: Filter;
      label: string;
      sublabel?: string;
      count: number;
    }
  | { id: string; type: "text"; text: string; label: string; count: number }
  | { id: string; type: "tx"; tx: Transaction }
  | { id: string; type: "recent"; query: Query; label: string }
  | { id: string; type: "empty"; label: string };

export type Group = { id: string; title?: string; items: Item[] };

function score(name: string, q: string): number {
  const n = name.toLowerCase();
  if (!q) return 1;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.split(/[\s:]+/).some((w) => w.startsWith(q))) return 60;
  if (n.includes(q)) return 40;
  return 0;
}

export function accountSublabel(a: Account): string {
  if (a.groupLabel) return a.groupLabel;
  return a.kind === "credit" ? "Credit card" : a.kind === "offbudget" ? "Off budget" : "Account";
}

function amountHint(f: Extract<Filter, { kind: "amount" }>): string {
  switch (f.op) {
    case ">":
      return "more than";
    case "<":
      return "less than";
    case ">=":
      return "at least";
    case "<=":
      return "at most";
    case "=":
      return "exactly";
    case "between":
      return "between";
  }
}

function rangeHint(r: DateRange): string {
  const format = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  return r.start === r.end ? format(r.start) : `${format(r.start)} – ${format(r.end)}`;
}

export function buildSuggestions(opts: {
  input: string;
  filters: Filter[];
  data: BudgetData;
  ctx: SearchCtx;
  recents: Query[];
  scopeAccountId?: number | null;
  searchAll?: boolean;
  now?: Date;
}): Group[] {
  const { input, filters, data, ctx, recents, scopeAccountId = null, searchAll = true, now } = opts;
  const parsed = parseInput(input);
  const scoped = data.transactions.filter((tx) =>
    inScope(tx, scopeAccountId, searchAll, explicitAccountId(filters, data))
  );
  const base = scoped.filter((tx) => filters.every((f) => matchesFilter(tx, f, ctx)));
  const countWith = (f: Filter) => base.reduce((n, tx) => n + (matchesFilter(tx, f, ctx) ? 1 : 0), 0);
  const has = (f: Filter) => filters.some((x) => filterId(x) === filterId(f));

  const payeeFreq = new Map<string, number>();
  for (const tx of base) {
    const name = (tx.payee || "").trim() || "(no payee)";
    payeeFreq.set(name, (payeeFreq.get(name) ?? 0) + 1);
  }

  const groups: Group[] = [];

  // ---- key context: "payee:whol" ----
  if (parsed.key) {
    const key = parsed.key;
    const q = parsed.value.trim().toLowerCase();
    const items: Item[] = [];

    if (key === "payee") {
      const names = [...payeeFreq.keys()];
      const allNames = new Set(
        scoped.map((t) => (t.payee || "").trim() || "(no payee)")
      );
      for (const n of allNames) if (!payeeFreq.has(n)) names.push(n);
      names
        .map((n) => ({ n, s: score(n, q), c: payeeFreq.get(n) ?? 0 }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || b.c - a.c || a.n.localeCompare(b.n))
        .slice(0, 8)
        .forEach((x) => {
          const filter: Filter = { kind: "payee", value: x.n, exact: true };
          items.push({ id: `p:${x.n}`, type: "filter", key, filter, label: x.n, count: x.c });
        });
      if (q && !items.some((i) => i.type === "filter" && i.label.toLowerCase() === q)) {
        const filter: Filter = { kind: "payee", value: parsed.value.trim() };
        items.push({
          id: "p:contains",
          type: "filter",
          key,
          filter,
          label: `Payee contains “${parsed.value.trim()}”`,
          count: countWith(filter),
        });
      }
    }

    if (key === "category") {
      const groupNames = [...new Set(data.groups.map((g) => g.name))];
      const scored = [
        ...data.categories.map((c) => {
          const groupName = ctx.categoryById.get(c.id)?.groupName ?? "";
          return {
            label: c.name,
            sub: groupName,
            s: score(c.name, q),
            filter: { kind: "category", value: c.name, exact: true } as Filter,
          };
        }),
        ...groupNames.map((g) => ({
          label: g,
          sub: "Group",
          s: score(g, q) * 0.9,
          filter: { kind: "category", value: g, exact: true } as Filter,
        })),
      ]
        .filter((x) => x.s > 0)
        .map((x) => ({ ...x, c: countWith(x.filter) }))
        .sort((a, b) => b.s - a.s || b.c - a.c)
        .slice(0, 9);
      scored.forEach((x) =>
        items.push({
          id: `c:${x.label}`,
          type: "filter",
          key,
          filter: x.filter,
          label: x.label,
          sublabel: x.sub,
          count: x.c,
        })
      );
      const uncategorized: Filter = { kind: "is", value: "uncategorized" };
      if (!q || "uncategorized".startsWith(q)) {
        items.push({
          id: "c:uncat",
          type: "filter",
          key,
          filter: uncategorized,
          label: "Uncategorized",
          sublabel: "Needs a category",
          count: countWith(uncategorized),
        });
      }
    }

    if (key === "account") {
      data.accounts
        .map((a) => ({ a, s: Math.max(score(a.name, q), score(accountSublabel(a), q) * 0.7) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .forEach((x) => {
          const filter: Filter = { kind: "account", value: x.a.name, exact: true };
          items.push({
            id: `a:${x.a.id}`,
            type: "filter",
            key,
            filter,
            label: x.a.name,
            sublabel: accountSublabel(x.a),
            count: countWith(filter),
          });
        });
    }

    if (key === "amount") {
      const custom = parseSearchAmount(parsed.value);
      if (custom) {
        items.push({
          id: "amt:custom",
          type: "filter",
          key,
          filter: custom,
          label: amountLabel(custom),
          sublabel: amountHint(custom),
          count: countWith(custom),
        });
      }
      if (!custom) {
        const presets: Extract<Filter, { kind: "amount" }>[] = [
          { kind: "amount", op: ">", a: 100 },
          { kind: "amount", op: ">", a: 500 },
          { kind: "amount", op: "<", a: 10 },
          { kind: "amount", op: "between", a: 20, b: 50 },
        ];
        presets.forEach((p) =>
          items.push({
            id: `amt:${amountLabel(p)}`,
            type: "filter",
            key,
            filter: p,
            label: amountLabel(p),
            sublabel: amountHint(p),
            count: countWith(p),
          })
        );
        if (parsed.value.trim())
          items.push({ id: "amt:help", type: "empty", label: "Try  >50   <20   =12.99   10..50" });
      }
    }

    if (key === "date") {
      const custom = parseSearchDate(parsed.value, now);
      const presets = datePresets(now);
      const matchedPresets = presets.filter(
        (p) => !q || normKey(p.label).includes(normKey(q)) || normKey(p.id).includes(normKey(q))
      );
      if (
        custom &&
        !matchedPresets.some((p) => p.range.start === custom.start && p.range.end === custom.end)
      ) {
        const f: Filter = { kind: "date", ...custom };
        items.push({
          id: "d:custom",
          type: "filter",
          key,
          filter: f,
          label: custom.label,
          sublabel: rangeHint(custom),
          count: countWith(f),
        });
      }
      matchedPresets.forEach((p) => {
        const f: Filter = { kind: "date", ...p.range };
        items.push({
          id: `d:${p.id}`,
          type: "filter",
          key,
          filter: f,
          label: p.label,
          sublabel: rangeHint(p.range),
          count: countWith(f),
        });
      });
      if (items.length === 0)
        items.push({
          id: "d:help",
          type: "empty",
          label: "Try  this month · last 30 days · march · 2025-03 · 2025-03-14",
        });
    }

    if (key === "memo") {
      if (parsed.value.trim()) {
        const f: Filter = { kind: "memo", value: parsed.value.trim() };
        items.push({
          id: "m:custom",
          type: "filter",
          key,
          filter: f,
          label: `Memo contains “${parsed.value.trim()}”`,
          count: countWith(f),
        });
      }
      const words = new Map<string, number>();
      for (const tx of base)
        for (const w of (tx.memo ?? "").toLowerCase().split(/[^a-z0-9']+/))
          if (w.length > 2) words.set(w, (words.get(w) ?? 0) + 1);
      [...words.entries()]
        .filter(([w]) => !q || (w.startsWith(q) && w !== q))
        .sort((a, b) => b[1]! - a[1]!)
        .slice(0, 6)
        .forEach(([w, c]) =>
          items.push({
            id: `m:${w}`,
            type: "filter",
            key,
            filter: { kind: "memo", value: w },
            label: w,
            count: c,
          })
        );
    }

    if (key === "is") {
      STATUS_OPTIONS.filter(
        (o) => !q || o.value.startsWith(q) || o.label.toLowerCase().startsWith(q)
      ).forEach((o) => {
        const f: Filter = { kind: "is", value: o.value };
        items.push({
          id: `is:${o.value}`,
          type: "filter",
          key,
          filter: f,
          label: o.label,
          sublabel: o.hint,
          count: countWith(f),
        });
      });
    }

    const visible = items.filter((i) => i.type !== "filter" || !has(i.filter));
    if (visible.length === 0)
      visible.push({
        id: "none",
        type: "empty",
        label: `No ${KEYS[key].label.toLowerCase()} matches “${parsed.value.trim()}”`,
      });
    groups.push({ id: "ctx", title: KEYS[key].label, items: visible });
    return groups;
  }

  // ---- empty input: starting point ----
  const q = parsed.value.trim().toLowerCase();
  if (!q) {
    if (recents.length) {
      groups.push({
        id: "recent",
        title: "Recent",
        items: recents
          .slice(0, 4)
          .map((r, i) => ({ id: `r${i}`, type: "recent", query: r, label: serializeQuery(r) }) as Item),
      });
    }
    groups.push({
      id: "keys",
      title: "Filter by",
      items: KEY_ORDER.map(
        (k) => ({ id: `k:${k}`, type: "key", key: k, label: KEYS[k].label, hint: KEYS[k].hint }) as Item
      ),
    });
    const quick: { label: string; f: Filter }[] = [
      { label: "Uncleared", f: { kind: "is", value: "uncleared" } },
      {
        label: "This month",
        f: { kind: "date", ...datePresets(now).find((p) => p.id === "this-month")!.range },
      },
      { label: "Flagged", f: { kind: "is", value: "flagged" } },
      { label: "Over $100", f: { kind: "amount", op: ">", a: 100 } },
    ];
    const seen = new Set<string>();
    const deduped = quick.filter((x) => {
      const id = filterId(x.f);
      if (seen.has(id) || has(x.f)) return false;
      seen.add(id);
      return true;
    });
    groups.push({
      id: "quick",
      title: "Quick filters",
      items: deduped.map((x) => ({
        id: `q:${x.label}`,
        type: "filter",
        key: x.f.kind,
        filter: x.f,
        label: x.label,
        count: countWith(x.f),
      }) as Item),
    });
    // Chips committed but no text yet: list the matching transactions so the
    // count in the footer is actionable without requiring free text.
    if (filters.length > 0) {
      const preview: Item[] = [...base]
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id))
        .slice(0, 8)
        .map((tx) => ({ id: `tx:${tx.id}`, type: "tx", tx }) as Item);
      if (preview.length) groups.push({ id: "txs", title: "Matching transactions", items: preview });
    }
    return groups;
  }

  // ---- free text ----
  const tokens = textTokens(q);
  const textCount = base.filter((tx) => matchesText(tx, tokens, ctx)).length;
  groups.push({
    id: "text",
    items: [
      {
        id: "text",
        type: "text",
        text: parsed.value,
        label: parsed.value.trim(),
        count: textCount,
      },
    ],
  });

  const keyItems = KEY_ORDER.filter(
    (k) => k.startsWith(q) || KEYS[k].label.toLowerCase().startsWith(q)
  ).map(
    (k) => ({ id: `k:${k}`, type: "key", key: k, label: KEYS[k].label, hint: KEYS[k].hint }) as Item
  );
  if (keyItems.length) groups.push({ id: "keys", title: "Filters", items: keyItems });

  const amt = parseSearchAmount(q);
  if (amt) {
    const around: Filter = {
      kind: "amount",
      op: "between",
      a: Math.max(0, amt.a - 1),
      b: amt.a + 1,
    };
    groups.push({
      id: "amount",
      title: "Amount",
      items: [
        {
          id: "amt:eq",
          type: "filter",
          key: "amount",
          filter: amt,
          label: amountLabel(amt),
          sublabel: amountHint(amt),
          count: countWith(amt),
        },
        ...(amt.op === "="
          ? [
              {
                id: "amt:near",
                type: "filter",
                key: "amount",
                filter: around,
                label: `≈ ${amountLabel(amt)}`,
                sublabel: "within a dollar",
                count: countWith(around),
              } as Item,
            ]
          : []),
      ],
    });
  }

  const dateGuess = parseSearchDate(q, now);
  if (dateGuess) {
    const f: Filter = { kind: "date", ...dateGuess };
    groups.push({
      id: "date",
      title: "Date",
      items: [
        {
          id: "d:guess",
          type: "filter",
          key: "date",
          filter: f,
          label: dateGuess.label,
          sublabel: rangeHint(dateGuess),
          count: countWith(f),
        },
      ],
    });
  }

  const payeeItems: Item[] = [...new Set(scoped.map((t) => (t.payee || "").trim() || "(no payee)"))]
    .map((n) => ({ n, s: score(n, q), c: payeeFreq.get(n) ?? 0 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.c - a.c)
    .slice(0, 4)
    .map((x) => ({
      id: `p:${x.n}`,
      type: "filter",
      key: "payee",
      filter: { kind: "payee", value: x.n, exact: true },
      label: x.n,
      count: x.c,
    }) as Item);
  if (payeeItems.length) groups.push({ id: "payees", title: "Payees", items: payeeItems });

  const catItems: Item[] = data.categories
    .map((c) => {
      const groupName = ctx.categoryById.get(c.id)?.groupName ?? "";
      return { c, groupName, s: Math.max(score(c.name, q), score(groupName, q) * 0.8) };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map((x) => {
      const f: Filter = { kind: "category", value: x.c.name, exact: true };
      return {
        id: `c:${x.c.id}`,
        type: "filter",
        key: "category",
        filter: f,
        label: x.c.name,
        sublabel: x.groupName,
        count: countWith(f),
      } as Item;
    });
  if (catItems.length) groups.push({ id: "cats", title: "Categories", items: catItems });

  const acctItems: Item[] = data.accounts
    .filter((a) => score(a.name, q) > 0 || accountSublabel(a).toLowerCase().startsWith(q))
    .map((a) => {
      const f: Filter = { kind: "account", value: a.name, exact: true };
      return {
        id: `a:${a.id}`,
        type: "filter",
        key: "account",
        filter: f,
        label: a.name,
        sublabel: accountSublabel(a),
        count: countWith(f),
      } as Item;
    });
  if (acctItems.length) groups.push({ id: "accts", title: "Accounts", items: acctItems });

  const statusItems: Item[] = STATUS_OPTIONS.filter((o) => o.value.startsWith(q) && q.length >= 2).map(
    (o) => {
      const f: Filter = { kind: "is", value: o.value };
      return {
        id: `is:${o.value}`,
        type: "filter",
        key: "is",
        filter: f,
        label: o.label,
        sublabel: o.hint,
        count: countWith(f),
      } as Item;
    }
  );
  if (statusItems.length) groups.push({ id: "status", title: "Status", items: statusItems });

  const txItems: Item[] = base
    .filter((tx) => matchesText(tx, tokens, ctx))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id))
    .slice(0, 5)
    .map((tx) => ({ id: `tx:${tx.id}`, type: "tx", tx }) as Item);
  if (txItems.length) groups.push({ id: "txs", title: "Transactions", items: txItems });

  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => i.type !== "filter" || !has(i.filter)),
    }))
    .filter((g) => g.items.length);
}

function explicitAccountId(filters: Filter[], data: BudgetData): number | null {
  const f = filters.find((x) => x.kind === "account" && x.exact);
  if (!f || f.kind !== "account") return null;
  const want = f.value.toLowerCase();
  const hit = data.accounts.find((a) => a.name.toLowerCase() === want);
  return hit ? hit.id : null;
}

/** Resolve an exact account/category filter to its numeric id (for jumps). */
export function resolveAccountId(data: BudgetData, value: string): number | null {
  const want = value.toLowerCase();
  return data.accounts.find((a) => a.name.toLowerCase() === want)?.id ?? null;
}

export function resolveCategoryId(data: BudgetData, value: string): number | null {
  const want = value.toLowerCase();
  const byName = data.categories.find((c) => c.name.toLowerCase() === want)?.id ?? null;
  if (byName != null) return byName;
  // Group names resolve to null (no single category) — caller treats as text.
  return null;
}
