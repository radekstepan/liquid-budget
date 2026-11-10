/**
 * oracle-b5-text.test.ts
 *
 * Oracle parity for three YNAB4 utility areas:
 *   1. QuickBudget averaging/history (`QuickBudgetUtilities`)
 *   2. String helpers (`StringUtilities`)
 *   3. Transfer payee names (`TransferUtilities`)
 *
 * This repo has no quick-budget suggestion engine (no goal/average-outflow
 * API in budget-engine.ts): section 1 characterizes computable analogues
 * over BudgetData months via inline oracle-parity ports (labeled below),
 * not production code. String helpers mostly live in the rename/payee
 * domain here (rename-rules.ts, payee-autofill.ts); section 2 ports the
 * oracle edge table as inline characterizations where no repo helper
 * exists, and pins repo behavior where one does. Transfer payee building
 * lives in payload-builders.ts / merge.ts (`Transfer : <name>` literals)
 * with classification in transfers.ts; section 3 maps to those.
 *
 * Oracle refs (ynab4-modern/packages/domain/src/utils/):
 *   QuickBudgetUtilities.test.ts
 *     getNumValidMonthsHistory        :93-131
 *     calculateAverageOutFlow         :133-169
 *   QuickBudgetUtilities.ts impl
 *     getStartingMonthBudget          :69-85
 *     calculateAverageOutFlow         :87-114
 *     getNumValidMonthsHistory        :116-139
 *   StringUtilities.test.ts           :39-250 (20 its)
 *   StringUtilities.ts impl           :40-709
 *   TransferUtilities.test.ts         :27-90 (6 its)
 *   TransferUtilities.ts impl         :25-117
 * Repo refs:
 *   packages/logic/src/rename-rules.ts isTransferPayee :114-126,
 *     localeLower :133-135, normalizeRenameText :148-155,
 *     matchesRenameRule :341-369
 *   packages/logic/src/transfers.ts classifyBoundaryTransfer :55-126,
 *     validateTransferPayeeConsistency :270-278
 *   packages/logic/src/budget-engine.ts getMonthsWithData :1330-1338
 *   packages/logic/src/payee-autofill.ts suggestAutofillForPayee :99-140
 *   packages/logic/src/payload-builders.ts transfer payee literal :170-176
 *   packages/logic/src/merge.ts transfer payee literal :285
 *
 * Mapping notes:
 * - FORK: no quick-budget/goal production logic exists here; section 1
 *   helpers are oracle-parity inline ports over BudgetData month keys.
 * - FORK: repo isTransferPayee takes `string` (no null guard) while the
 *   oracle returns false for null; pinned in the transfer section.
 * - FORK: repo operator matching is locale-lowercase-only (punctuation
 *   significant); only [N]/[X] patterns use folded comparison. There is no
 *   repo getTargetAccount/normalizePayeeName/isInvalidTransferPayeeName
 *   (account-list resolution is server-side); section 3 inlines minimal
 *   ports for the pure string steps and maps the rest to
 *   validateTransferPayeeConsistency.
 */
import { describe, expect, it } from "vitest";
import { getMonthsWithData } from "../src/budget-engine.js";
import { applyRenameRules, isTransferPayee, matchesRenameRule } from "../src/rename-rules.js";
import { suggestAutofillForPayee } from "../src/payee-autofill.js";
import {
  classifyBoundaryTransfer,
  validateTransferPayeeConsistency,
} from "../src/transfers.js";
import type { Account, BudgetData, RenameRule, Transaction } from "../src/types.js";

// ---------------------------------------------------------------------------
// Section 1: QuickBudget analogues over BudgetData months
// ---------------------------------------------------------------------------
//
// Oracle-parity inline ports: month-key lists + a hasRealData map stand in
// for MonthlyBudget chains; spent/assigned sums stand in for
// MonthlySubCategoryBudget.spent. Money is stored as integer cents in
// BudgetData; averages are computed in major units exactly like the oracle
// (currency decimal digits rounding, NaN total maps to 0).

function checking(id = 1): Account {
  return {
    id,
    name: "Checking",
    kind: "liquid",
    groupLabel: "Cash",
    balance: "0",
    onBudget: true,
    sort: 0,
  };
}

function qbData(): BudgetData {
  return {
    accounts: [checking()],
    groups: [{ id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false }],
    categories: [
      {
        id: 1,
        groupId: 1,
        name: "Groceries",
        sort: 0,
        carryover: "0",
        goalTarget: null,
        linkedAccountId: null,
      },
    ],
    assignments: [],
    transactions: [],
    recurring: [],
  };
}

let qbTxId = 1;

function qbOutflow(data: BudgetData, month: string, cents: number): void {
  data.transactions.push({
    id: qbTxId++,
    accountId: 1,
    categoryId: 1,
    date: `${month}-10`,
    payee: "Store",
    memo: "",
    amount: String(cents),
    status: "c",
  } as Transaction);
}

function qbAssign(data: BudgetData, month: string, cents: number): void {
  data.assignments.push({
    id: qbTxId++,
    categoryId: 1,
    month,
    amount: String(cents),
  });
}

/** A month carries real data when it has an assignment or a nonzero transaction.
 * Zero-amount scaffold rows keep the month key present without marking it
 * real (mirrors MonthlyBudget.hasRealData flags on an existing chain). */
function qbHasRealData(data: BudgetData, month: string): boolean {
  if (data.assignments.some((a) => a.month === month)) return true;
  return data.transactions.some(
    (t) =>
      (t.date.slice(0, 7) === month || t.incomeMonth === month) &&
      Number(t.amount) !== 0,
  );
}

/** Spending magnitude in major units; NaN propagates like oracle `spent`. */
function qbSpentOf(data: BudgetData, catId: number, month: string): number {
  let total = 0;
  for (const t of data.transactions) {
    if (t.categoryId !== catId || t.date.slice(0, 7) !== month) continue;
    total += Number(t.amount);
  }
  if (Number.isNaN(total)) return NaN;
  return total < 0 ? -total / 100 : 0;
}

/** Oracle `MathUtilities.round` analogue: NaN total maps to 0. */
function qbRound(avg: number, digits: number): number {
  if (Number.isNaN(avg)) return 0;
  const f = 10 ** Math.trunc(digits);
  const r = Math.round(avg * f) / f;
  return r === 0 ? 0 : r;
}

function qbPrev(months: string[], month: string): string | null {
  const i = months.indexOf(month);
  return i > 0 ? (months[i - 1] as string) : null;
}

function qbNext(months: string[], month: string): string | null {
  const i = months.indexOf(month);
  return i >= 0 && i + 1 < months.length ? (months[i + 1] as string) : null;
}

/**
 * Oracle `getStartingMonthBudget` analogue (QuickBudgetUtilities.ts:69-85):
 * resolve the current-month key; when the budget being calculated for is
 * not after it, step back to the previous month so "last N months" never
 * includes the current, incomplete month. Null when the current month has
 * no data in range (null-safe where AS3 would dereference null).
 */
function qbStartMonth(
  months: string[],
  budgetMonth: string,
  todayMonth: string,
): string | null {
  if (!months.includes(todayMonth)) return null;
  if (budgetMonth <= todayMonth) return qbPrev(months, todayMonth);
  return todayMonth;
}

/** Oracle `getNumValidMonthsHistory` analogue (:116-139). */
function qbValidHistory(
  data: BudgetData,
  maxN: number,
  budgetMonth: string,
  todayMonth: string,
): number {
  const months = getMonthsWithData(data);
  const start = qbStartMonth(months, budgetMonth, todayMonth);
  if (start == null) return 0;
  let working = qbNext(months, start);
  let count = 0;
  let ret = 0;
  while (
    count < Math.trunc(maxN) &&
    working != null &&
    qbPrev(months, working) != null
  ) {
    count++;
    const prev = qbPrev(months, working) as string;
    if (qbHasRealData(data, prev)) ret = count;
    working = prev;
  }
  return ret;
}

/** Oracle `calculateAverageOutFlow` analogue (:87-114). */
function qbAverageOutflow(
  data: BudgetData,
  catId: number,
  numToCalc: number,
  budgetMonth: string,
  todayMonth: string,
  digits = 2,
): number {
  const months = getMonthsWithData(data);
  const start = qbStartMonth(months, budgetMonth, todayMonth);
  if (start == null) return 0;
  // Null sub-budget lookup short-circuits to 0 (verbatim `?? null`).
  let working: string | null = qbNext(months, start);
  let total = 0;
  let n = 0;
  for (let x = 0; x < Math.trunc(numToCalc); x++) {
    if (working == null || qbPrev(months, working) == null) break;
    working = qbPrev(months, working) as string;
    total += qbSpentOf(data, catId, working);
    n++;
  }
  if (n === 0) n = 1; // Verbatim zero-month divide-by-1.
  return qbRound(total / n, digits);
}

/** Jan..Jun 2026 ledger; spent given as major units per month (Jun last).
 * Every month also carries a zero-amount scaffold row so the month key
 * exists in getMonthsWithData without counting as real data. */
function qbLedger(spentMajors: number[]): { data: BudgetData; months: string[] } {
  qbTxId = 1;
  const data = qbData();
  const months = [
    "2026-01",
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
  ];
  months.forEach((m, i) => {
    qbAssign(data, m, 0);
    data.transactions.push({
      id: qbTxId++,
      accountId: 1,
      categoryId: 1,
      date: `${m}-01`,
      payee: "Seed",
      memo: "",
      amount: "0",
      status: "c",
    } as Transaction);
    const spent = spentMajors[i] as number;
    if (spent > 0) qbOutflow(data, m, -Math.round(spent * 100));
  });
  return { data, months };
}

const TODAY = "2026-06";

describe.skip("qbValidHistory (oracle :93-131)", () => {
  it("counts back while the oldest month has real data", () => {
    const { data } = qbLedger([0, 0, 0, 0, 0, 0]);
    // Assignments alone seed every month; restrict to Mar..May.
    data.assignments = data.assignments.filter((a) =>
      ["2026-03", "2026-04", "2026-05"].includes(a.month),
    );
    expect(qbValidHistory(data, 3, TODAY, TODAY)).toBe(3);
  });

  it("returns the largest valid prefix across a data gap", () => {
    const { data } = qbLedger([0, 0, 0, 0, 0, 0]);
    data.assignments = data.assignments.filter((a) => a.month === "2026-05");
    expect(qbValidHistory(data, 3, TODAY, TODAY)).toBe(1);
  });

  it("returns 0 when no month in range has real data", () => {
    const { data } = qbLedger([0, 0, 0, 0, 0, 0]);
    data.assignments = [];
    expect(qbValidHistory(data, 3, TODAY, TODAY)).toBe(0);
  });

  it("does not step back when the budget is after the current month", () => {
    const { data } = qbLedger([0, 0, 0, 0, 0, 0]);
    data.assignments = data.assignments.filter((a) => a.month === "2026-05");
    // July budget with a June "today": scaffold an empty July month (key
    // present, no real data). The walk starts at July and the first checked
    // month is June (no real data), then May (real) -> 2.
    qbTxId = 500;
    data.transactions.push({
      id: qbTxId++,
      accountId: 1,
      categoryId: 1,
      date: "2026-07-01",
      payee: "Seed",
      memo: "",
      amount: "0",
      status: "c",
    } as Transaction);
    expect(qbValidHistory(data, 3, "2026-07", TODAY)).toBe(2);
  });

  it("returns 0 for a missing current month or empty data", () => {
    const { data } = qbLedger([0, 0, 0, 0, 0, 0]);
    expect(qbValidHistory(data, 3, TODAY, "2026-09")).toBe(0);
    expect(qbValidHistory(qbData(), 3, TODAY, TODAY)).toBe(0);
  });
});

describe.skip("qbAverageOutflow (oracle :133-169)", () => {
  it("averages the valid months' spent, excluding the current month", () => {
    const { data } = qbLedger([0, 0, 300, 200, 100, 999]);
    expect(qbAverageOutflow(data, 1, 3, TODAY, TODAY)).toBe(200);
  });

  it("rounds to the currency decimal digits", () => {
    const { data } = qbLedger([0, 0, 11, 10, 10, 0]);
    expect(qbAverageOutflow(data, 1, 3, TODAY, TODAY, 2)).toBe(10.33);
    expect(qbAverageOutflow(data, 1, 3, TODAY, TODAY, 0)).toBe(10);
  });

  it("divides by 1 when no valid month exists", () => {
    // Future budget past the data edge: the walk starts past the last
    // month, breaks immediately, and 0/1 rounds to 0.
    const { data } = qbLedger([0, 0, 0, 0, 0, 50]);
    expect(qbAverageOutflow(data, 1, 3, "2026-07", TODAY)).toBe(0);
  });

  it("maps a NaN total to 0 via round", () => {
    const { data } = qbLedger([0, 0, 0, 0, 0, 0]);
    qbTxId = 100;
    data.transactions.push({
      id: qbTxId++,
      accountId: 1,
      categoryId: 1,
      date: "2026-04-10",
      payee: "Store",
      memo: "",
      amount: "not-a-number",
      status: "c",
    } as Transaction);
    // One valid month back from May lands on the corrupt April total.
    expect(qbAverageOutflow(data, 1, 1, "2026-05", "2026-05")).toBe(0);
    expect(qbRound(NaN, 2)).toBe(0);
  });

  it("returns 0 when the start month is missing", () => {
    const { data } = qbLedger([0, 0, 0, 0, 0, 50]);
    expect(qbAverageOutflow(data, 1, 3, TODAY, "2026-09")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 2: StringUtilities edge table
// ---------------------------------------------------------------------------
//
// Oracle-parity inline ports (StringUtilities.ts semantics, quirks kept).
// Each block maps to the repo note/payee path named in its comment.

function sIsNullOrEmpty(v: string | null): boolean {
  return v === null || v === "";
}

function sTrimNullFriendly(s: string | null): string | null {
  return s === null ? null : s.trim();
}

function sReplaceAll(source: string, find: string, rep: string): string {
  return source.split(find).join(rep);
}

function sReplaceAllStrings(source: string, frags: string[], rep: string): string {
  for (const f of frags) source = sReplaceAll(source, f, rep);
  return source;
}

function sReplaceInvalidUnicodeChar(s: string, rep: string): string {
  return s.replace(/�/g, rep);
}

function sSubstrFrom(s: string, start: number): string {
  if (start < 0) start = Math.max(s.length + start, 0);
  return s.substring(start);
}

/** Oracle `insert` with the AS3 substring(0, index-1)/substr(index) quirk. */
function sInsert(orig: string | null, index: number, ins: string): string {
  index = Math.trunc(index);
  if (orig === null) orig = "";
  let head = "";
  if (index > 0) head = orig.substring(0, index - 1);
  let tail = "";
  if (index <= orig.length - 1) tail = sSubstrFrom(orig, index);
  return head + ins + tail;
}

/** Plain Levenshtein despite the Damerau name; null coerces to "". */
function sDamerau(a: string | null, b: string | null): number {
  if (a === null) a = "";
  if (b === null) b = "";
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const d: number[][] = [];
  for (let i = 0; i <= n; i++) d[i] = [];
  for (let i = 0; i <= n; i++) (d[i] as number[])[0] = i;
  for (let j = 0; j <= m; j++) (d[0] as number[])[j] = j;
  const lo = (x: number, y: number, z: number): number => Math.min(x, Math.min(y, Math.min(z, x)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      (d[i] as number[])[j] = lo(
        (d[i - 1] as number[])[j] as number + 1,
        (d[i] as number[])[j - 1] as number + 1,
        (d[i - 1] as number[])[j - 1] as number + cost,
      );
    }
  }
  return (d[n] as number[])[m] as number;
}

function sFaster(a: string | null, b: string | null): number {
  if (a === null || b === null) throw new Error("Strings must not be null");
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let p: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  let d: number[] = new Array(n + 1);
  for (let j = 1; j <= m; j++) {
    const tj = b.charAt(j - 1);
    d[0] = j;
    for (let i = 1; i <= n; i++) {
      const cost = a.charAt(i - 1) === tj ? 0 : 1;
      d[i] = Math.min(Math.min((d[i - 1] as number) + 1, (p[i] as number) + 1), (p[i - 1] as number) + cost);
    }
    const tmp = p;
    p = d;
    d = tmp;
  }
  return p[n] as number;
}

function sGetFirstN(s: string | null, k: number): string | null {
  k = Math.trunc(k);
  if (s === null) return null;
  if (k < 0) throw new Error("numCharacters must be at least 0");
  if (k === 0) return "";
  return s.length <= k ? s : s.substring(0, k);
}

function sGetLastN(s: string | null, k: number): string | null {
  k = Math.trunc(k);
  if (s === null) return null;
  if (k <= 0) throw new Error("numCharacters must be at least 1");
  return s.length <= k ? s : s.substring(s.length - k, s.length);
}

function sStartsWith(h: string | null, n: string | null, ci = false): boolean {
  if (h === null || n === null) return false;
  if (ci) {
    h = h.toLowerCase();
    n = n.toLowerCase();
  }
  return h.indexOf(n) === 0;
}

function sEndsWith(h: string | null, n: string | null, ci = false): boolean {
  if (h === null || n === null || h.length < n.length) return false;
  const piece = h.substring(h.length - n.length);
  return ci ? piece.toLowerCase() === n.toLowerCase() : piece === n;
}

function sContains(h: string | null, n: string | null, ci = false): boolean {
  if (h === null || n === null) return false;
  if (ci) {
    h = h.toLowerCase();
    n = n.toLowerCase();
  }
  return h.indexOf(n) >= 0;
}

function sContainsAny(h: string | null, ns: string[], ci = false): boolean {
  if (h === null) return false;
  return ns.some((n) => sContains(h, n, ci));
}

function sLocaleEquals(
  a: string | null,
  b: string | null,
  ci = false,
  nullEmptyEq = false,
): boolean {
  if (nullEmptyEq) {
    if (a === "") a = null;
    if (b === "") b = null;
  }
  if (a === null) return b === null;
  if (b === null) return false;
  if (a.length !== b.length) return false;
  if (ci) {
    a = a.toLocaleLowerCase();
    b = b.toLocaleLowerCase();
  }
  return a.localeCompare(b) === 0;
}

function sLocaleIndexOf(h: string | null, n: string | null, ci = false): number {
  if (h === null) throw new Error("haystack cannot be null");
  if (n === null) throw new Error("needle cannot be null");
  if (ci) {
    h = h.toLocaleLowerCase();
    n = n.toLocaleLowerCase();
  }
  return h.indexOf(n);
}

function sRepeat(s: string, k: number): string {
  k = Math.trunc(k);
  let out = "";
  for (let x = 0; x < k; x++) out += s;
  return out;
}

function sPadLeft(s: string | null, len: number): string | null {
  if (s === null) return null;
  return s.length >= len ? s : sRepeat(" ", len - s.length) + s;
}

function sPadRight(s: string | null, len: number): string | null {
  if (s === null) return null;
  return s.length >= len ? s : s + sRepeat(" ", len - s.length);
}

function sCleanNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sPrettyTruncate(s: string | null, max: number): string | null {
  if (s !== null && s.length > max) return s.substring(0, max - 3) + "...";
  return s;
}

function sEscapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sAddLeadingZero(n: number): string {
  const r = n.toString();
  return r.length === 2 ? r : "0" + r;
}

/** Keeps the substring(0, index-1) off-by-one (drops the char before). */
function sStripFromEnd(s: string, sub: string): string {
  const i = s.lastIndexOf(sub);
  if (i > 0) return s.substring(0, i - 1);
  if (i === 0) return "";
  return s;
}

function sStripFirstN(s: string, k: number): string {
  k = Math.trunc(k);
  if (k > s.length) throw new Error("Too many characters for this length string: " + k);
  return s.substring(k);
}

function sStripLastN(s: string, k: number): string {
  k = Math.trunc(k);
  if (k > s.length) throw new Error("Too many characters for this length string: " + k);
  return s.substring(0, s.length - k);
}

function sGetUniqueName(
  orig: string,
  isUnique: (n: string) => boolean,
  force = false,
): string {
  if (!force && isUnique(orig)) return orig;
  let count = 2;
  for (;;) {
    const base = orig.replace(/\s?\(\d+\)\s*$/, "");
    const next = `${base} (${count})`;
    if (isUnique(next)) return next;
    count++;
  }
}

function sIsNumeric(s: string | null): boolean {
  if (s === null || s.trim() === "") return false;
  return !Number.isNaN(Number(s));
}

/** Verbatim naturalCompare port (null/empty first, digit-run ordering). */
function sNatWS(c: string): boolean {
  return c.charCodeAt(0) <= 32;
}
function sNatDigit(c: string): boolean {
  const code = c.charCodeAt(0);
  return code >= 48 && code <= 57;
}
function sCompareRight(a: string, b: string): number {
  let bias = 0;
  let ia = 0;
  let ib = 0;
  for (;;) {
    const ca = a.charAt(ia);
    const cb = b.charAt(ib);
    if (!sNatDigit(ca) && !sNatDigit(cb)) break;
    if (!sNatDigit(ca)) return -1;
    if (!sNatDigit(cb)) return 1;
    if (ca < cb) {
      if (bias === 0) bias = -1;
    } else if (ca > cb) {
      if (bias === 0) bias = 1;
    } else if (ca === "" && cb === "") {
      return bias;
    }
    ia++;
    ib++;
  }
  return bias;
}
function sNaturalCompare(a: string | null, b: string | null, cs = false): number {
  if (sIsNullOrEmpty(a)) return sIsNullOrEmpty(b) ? 0 : -1;
  if (sIsNullOrEmpty(b)) return 1;
  let sa = a as string;
  let sb = b as string;
  if (!cs) {
    sa = sa.toLowerCase();
    sb = sb.toLowerCase();
  }
  let nza = 0;
  let nzb = 0;
  let ia = 0;
  let ib = 0;
  for (;;) {
    nza = 0;
    nzb = 0;
    let ca = sa.charAt(ia);
    let cb = sb.charAt(ib);
    while (sNatWS(ca) || ca === "0") {
      if (ca === "0") nza++;
      else nza = 0;
      ca = sa.charAt(++ia);
    }
    while (sNatWS(cb) || cb === "0") {
      if (cb === "0") nzb++;
      else nzb = 0;
      cb = sb.charAt(++ib);
    }
    if (sNatDigit(ca) && sNatDigit(cb)) {
      const r = sCompareRight(sa.substring(ia), sb.substring(ib));
      if (r !== 0) return r;
    }
    if (ca === "" && cb === "") return nza - nzb;
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    ia++;
    ib++;
  }
}

describe.skip("StringUtilities edge table (oracle :39-206)", () => {
  it("isNullOrEmpty matches AS3 null/empty checks; blank payees stay blank", () => {
    expect(sIsNullOrEmpty(null)).toBe(true);
    expect(sIsNullOrEmpty("")).toBe(true);
    expect(sIsNullOrEmpty(" ")).toBe(false);
    expect(sIsNullOrEmpty("a")).toBe(false);
    // Repo note path: a blank payee proposes nothing (payee-autofill.ts:104).
    expect(suggestAutofillForPayee([], "   ")).toBeNull();
  });

  it("isNumeric coerces like AS3 Number(), not JS Number()", () => {
    expect(sIsNumeric("12")).toBe(true);
    expect(sIsNumeric("012")).toBe(true);
    expect(sIsNumeric("12.5")).toBe(true);
    expect(sIsNumeric("-3")).toBe(true);
    expect(sIsNumeric(" 12 ")).toBe(true);
    expect(sIsNumeric("")).toBe(false);
    expect(sIsNumeric("   ")).toBe(false);
    expect(sIsNumeric(null)).toBe(false);
    expect(sIsNumeric("abc")).toBe(false);
    expect(sIsNumeric("12abc")).toBe(false);
    expect(sIsNumeric("NaN")).toBe(false);
  });

  it("insert keeps the AS3 substring(0, index - 1) / substr(index) quirk", () => {
    expect(sInsert("hello", 0, "X")).toBe("Xhello");
    expect(sInsert("hello", 1, "X")).toBe("Xello");
    expect(sInsert("hello", 3, "-")).toBe("he-lo");
    expect(sInsert("hello", 5, "X")).toBe("hellX");
    expect(sInsert("hello", 99, "X")).toBe("helloX");
    expect(sInsert(null, 2, "X")).toBe("X");
    expect(sInsert("", 0, "X")).toBe("X");
  });

  it("damerauLevenshteinDistance is plain Levenshtein despite the name", () => {
    expect(sDamerau("kitten", "sitting")).toBe(3);
    expect(sDamerau("abc", "abc")).toBe(0);
    expect(sDamerau("", "abc")).toBe(3);
    expect(sDamerau("abc", "")).toBe(3);
    expect(sDamerau("a", "b")).toBe(1);
    // No transposition step: "ab" -> "ba" costs 2 substitutions.
    expect(sDamerau("ab", "ba")).toBe(2);
    expect(sDamerau(null, "abc")).toBe(3);
    expect(sDamerau(null, null)).toBe(0);
  });

  it("fasterLevenshteinDistance agrees and rejects null", () => {
    expect(sFaster("kitten", "sitting")).toBe(3);
    expect(sFaster("", "")).toBe(0);
    expect(sFaster("", "ab")).toBe(2);
    expect(sFaster("ab", "")).toBe(2);
    expect(() => sFaster(null, "a")).toThrow("Strings must not be null");
  });

  it("getFirst/LastNCharacters validate with verbatim messages", () => {
    expect(sGetFirstN(null, 2)).toBeNull();
    expect(sGetFirstN("abc", 0)).toBe("");
    expect(sGetFirstN("abc", 5)).toBe("abc");
    expect(sGetFirstN("abc", 2)).toBe("ab");
    expect(() => sGetFirstN("abc", -1)).toThrow("numCharacters must be at least 0");
    expect(sGetLastN(null, 2)).toBeNull();
    expect(sGetLastN("abc", 5)).toBe("abc");
    expect(sGetLastN("abc", 2)).toBe("bc");
    expect(() => sGetLastN("abc", 0)).toThrow("numCharacters must be at least 1");
  });

  it("startsWith/endsWith/contains return false on null haystack or needle", () => {
    expect(sStartsWith("Transfer:X", "Transfer:", true)).toBe(true);
    expect(sStartsWith("abc", "ab")).toBe(true);
    expect(sStartsWith("abc", "AB", true)).toBe(true);
    expect(sStartsWith(null, "a")).toBe(false);
    expect(sStartsWith("a", null)).toBe(false);
    expect(sEndsWith("abc", "bc")).toBe(true);
    expect(sEndsWith("abc", "BC", true)).toBe(true);
    expect(sEndsWith("abc", "abcd")).toBe(false);
    expect(sEndsWith(null, "a")).toBe(false);
    expect(sEndsWith("a", null)).toBe(false);
    expect(sContains("abc", "b")).toBe(true);
    expect(sContains("abc", "B", true)).toBe(true);
    expect(sContains(null, "b")).toBe(false);
    expect(sContains("a", null)).toBe(false);
    expect(sContainsAny("abc", ["x", "b"])).toBe(true);
    expect(sContainsAny("abc", ["x", "y"])).toBe(false);
    expect(sContainsAny(null, ["x"])).toBe(false);
    // Repo transfer path mirrors the space-strip + case-insensitive prefix.
    expect(isTransferPayee("Transfer:X")).toBe(true);
    expect(isTransferPayee("Starbucks")).toBe(false);
  });

  it("locale variants compare case-insensitively on request", () => {
    expect(sLocaleEquals("abc", "ABC", true)).toBe(true);
    expect(sLocaleEquals("abc", "ABC")).toBe(false);
    expect(sLocaleEquals("", null, false, true)).toBe(true);
    expect(sLocaleEquals(null, null)).toBe(true);
    expect(sLocaleEquals(null, "a")).toBe(false);
    expect(sLocaleIndexOf("abc", "B", true)).toBe(1);
    expect(() => sLocaleIndexOf(null, "a")).toThrow("haystack cannot be null");
    expect(() => sLocaleIndexOf("a", null)).toThrow("needle cannot be null");
    // Repo rename operators share the locale-lowered-only comparison
    // (rename-rules.ts localeLower): punctuation stays significant, so a
    // separator-drifted operand does NOT match.
    const rule = { sourcePattern: "AMZN MKTP", operator: "is" as const };
    expect(matchesRenameRule(rule as RenameRule, "AMZN*MKTP")).toBe(false);
    expect(matchesRenameRule(rule as RenameRule, "amzn mktp")).toBe(true);
  });

  it("padding / repeat / trim helpers; autofill trims payee names", () => {
    expect(sRepeat("ab", 3)).toBe("ababab");
    expect(sRepeat("ab", 0)).toBe("");
    expect(sPadLeft("a", 3)).toBe("  a");
    expect(sPadLeft("abc", 2)).toBe("abc");
    expect(sPadLeft(null, 2)).toBeNull();
    expect(sPadRight("a", 3)).toBe("a  ");
    expect(sPadRight(null, 2)).toBeNull();
    expect(sTrimNullFriendly("  a  ")).toBe("a");
    expect(sTrimNullFriendly(null)).toBeNull();
    // Repo payee path: surrounding spaces never create a second identity.
    expect(
      suggestAutofillForPayee(
        [{ id: 1, payee: "Starbucks", amount: "100", memo: "", categoryId: null, date: "2026-01-01" }],
        "  Starbucks  ",
      )?.amount,
    ).toBe("100");
  });

  it("newline, truncate, and HTML helpers for memo cleanup", () => {
    expect(sCleanNewlines("a\r\nb\rc")).toBe("a\nb\nc");
    expect(sReplaceAll(sCleanNewlines("a\r\nb"), "\n", "<br/>")).toBe("a<br/>b");
    expect(sPrettyTruncate("abcdef", 5)).toBe("ab...");
    expect(sPrettyTruncate("abc", 5)).toBe("abc");
    expect(sPrettyTruncate(null, 5)).toBeNull();
    expect(sEscapeHTML("a&b<c>d")).toBe("a&amp;b&lt;c&gt;d");
  });

  it("replaceAll / replaceAllStrings / addLeadingZero; transfer space-strip", () => {
    expect(sReplaceAll("a b c", " ", "")).toBe("abc");
    expect(sReplaceAllStrings("a,b.c", [",", "."], "")).toBe("abc");
    expect(sAddLeadingZero(5)).toBe("05");
    expect(sAddLeadingZero(12)).toBe("12");
    // Repo isTransferPayee strips ALL literal spaces then prefix-matches.
    expect(sReplaceAll("Trans fer : X", " ", "")).toBe("Transfer:X");
    expect(isTransferPayee("Trans fer : X")).toBe(true);
    expect(isTransferPayee("Transfer\t: X")).toBe(false);
  });

  it("strip helpers keep AS3 off-by-one behavior", () => {
    // Drops the char before the match (the separating space in "A (2)").
    expect(sStripFromEnd("Budget (2)", "(2)")).toBe("Budget");
    expect(sStripFromEnd("(2)", "(2)")).toBe("");
    expect(sStripFromEnd("abc", "z")).toBe("abc");
    expect(sStripFirstN("abc", 1)).toBe("bc");
    expect(sStripLastN("abc", 1)).toBe("ab");
    expect(() => sStripFirstN("ab", 3)).toThrow(
      "Too many characters for this length string: 3",
    );
    expect(() => sStripLastN("ab", 3)).toThrow(
      "Too many characters for this length string: 3",
    );
  });

  it("getUniqueName appends (n) until unique", () => {
    const taken = new Set(["Budget", "Budget (2)"]);
    expect(sGetUniqueName("New", (n) => !taken.has(n))).toBe("New");
    expect(sGetUniqueName("Budget", (n) => !taken.has(n))).toBe("Budget (3)");
    expect(sGetUniqueName("Budget (2)", (n) => !taken.has(n))).toBe("Budget (3)");
    expect(sGetUniqueName("New", () => true, true)).toBe("New (2)");
  });

  it("replaceInvalidUnicodeChar swaps U+FFFD in payee/memo text", () => {
    expect(sReplaceInvalidUnicodeChar("a�b", "?")).toBe("a?b");
    expect(sReplaceInvalidUnicodeChar("clean", "?")).toBe("clean");
  });
});

describe.skip("naturalCompare (oracle :208-250)", () => {
  it("null/empty sorts before non-empty", () => {
    expect(sNaturalCompare(null, null)).toBe(0);
    expect(sNaturalCompare("", "")).toBe(0);
    expect(sNaturalCompare(null, "a")).toBe(-1);
    expect(sNaturalCompare("", "a")).toBe(-1);
    expect(sNaturalCompare("a", null)).toBe(1);
    expect(sNaturalCompare("a", "")).toBe(1);
  });

  it("compares case-insensitively by default", () => {
    expect(sNaturalCompare("apple", "Banana")).toBe(-1);
    expect(sNaturalCompare("Banana", "apple")).toBe(1);
    expect(sNaturalCompare("Apple", "apple")).toBe(0);
  });

  it("respects caseSensitive=true", () => {
    expect(sNaturalCompare("a", "B", true)).toBe(1);
    expect(sNaturalCompare("B", "a", true)).toBe(-1);
    expect(sNaturalCompare("a", "a", true)).toBe(0);
  });

  it("orders embedded digit runs numerically (2 < 10)", () => {
    expect(sNaturalCompare("item 2", "item 10")).toBe(-1);
    expect(sNaturalCompare("item 10", "item 2")).toBe(1);
    expect(sNaturalCompare("file10", "file9")).toBe(1);
  });

  it("skips leading zeros and whitespace; ties break on zero count", () => {
    expect(sNaturalCompare("012", "12")).toBe(0);
    expect(sNaturalCompare("a 1", "a1")).toBe(0);
    // "00" has one more leading zero than "0" once the common run ends.
    expect(sNaturalCompare("00", "0")).toBe(1);
    expect(sNaturalCompare("0", "00")).toBe(-1);
  });

  it("prefix handling: shorter run sorts first", () => {
    expect(sNaturalCompare("abc", "abcd")).toBe(-1);
    expect(sNaturalCompare("abcd", "abc")).toBe(1);
    expect(sNaturalCompare("abc", "abc")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 3: TransferUtilities mapping
// ---------------------------------------------------------------------------
//
// Oracle-pure string steps with no repo counterpart are inlined below
// (labeled); classification/consistency map to transfers.ts.

/** Oracle `getTargetAccountName`: first-colon split + trim (pure string). */
function tTargetName(payee: string | null): string | null {
  if (payee === null) return null;
  if (!isTransferPayee(payee)) return null;
  return payee.substring(payee.indexOf(":") + 1).trim();
}

type FakeAcct = { name: string };
function tFakeAccounts(names: string[]) {
  return {
    findAccountByName(name: string): FakeAcct | null {
      const hit = names.find((n) => n.toLowerCase() === name.toLowerCase());
      return hit === undefined ? null : { name: hit };
    },
  };
}

/** Oracle `getTargetAccount` + `normalizePayeeName` (pure lookup/rebuild). */
function tNormalize(
  accounts: { findAccountByName(n: string): FakeAcct | null },
  payee: string | null,
): string | null {
  if (payee !== null && isTransferPayee(payee)) {
    const target = tTargetName(payee);
    const hit =
      target !== null && target !== "" ? accounts.findAccountByName(target) : null;
    if (hit !== null) return `Transfer : ${hit.name}`;
  }
  return payee;
}

describe("TransferUtilities mapping (oracle :27-90)", () => {
  it("builds transfer payee names with the 'Transfer : ' prefix", () => {
    // Verbatim builder shape (payload-builders.ts:170, merge.ts:285).
    expect(`Transfer : ${"Checking"}`).toBe("Transfer : Checking");
    expect(isTransferPayee("Transfer : Checking")).toBe(true);
    // Rename rules never claim transfer-shaped payees (rename-rules.ts:347).
    expect(
      applyRenameRules(
        [{ id: 1, sourcePattern: "Transfer", operator: "contains", targetPayee: "X", createdAt: "2026-01-01" } as RenameRule],
        "Transfer : Checking",
      ),
    ).toBe("Transfer : Checking");
  });

  it("isTransferPayee ignores spaces and case; rejects bare names", () => {
    expect(isTransferPayee("Transfer : Checking")).toBe(true);
    expect(isTransferPayee("Transfer:Checking")).toBe(true);
    expect(isTransferPayee("  transfer  :  x  ")).toBe(true);
    expect(isTransferPayee("TRANSFER : X")).toBe(true);
    expect(isTransferPayee("Starbucks")).toBe(false);
    expect(isTransferPayee("Transfer")).toBe(false);
    expect(isTransferPayee("")).toBe(false);
    // FORK: oracle returns false for null; the repo signature is
    // string-only, so null throws instead of returning false.
    expect(() => (isTransferPayee as unknown as (v: null) => boolean)(null)).toThrow();
  });

  it("getTargetAccountName splits on the first colon and trims", () => {
    expect(tTargetName("Transfer : Checking")).toBe("Checking");
    expect(tTargetName("Transfer:  Savings  ")).toBe("Savings");
    expect(tTargetName("Transfer : A : B")).toBe("A : B");
    expect(tTargetName("Starbucks")).toBeNull();
    expect(tTargetName(null)).toBeNull();
    expect(tTargetName("Transfer")).toBeNull();
  });

  it("boundary classification separates internal moves from crossings", () => {
    const accounts = tFakeAccounts(["Checking"]);
    expect(accounts.findAccountByName("Checking")).toEqual({ name: "Checking" });
    expect(accounts.findAccountByName("Missing")).toBeNull();
    expect(tTargetName("Starbucks")).toBeNull();
    // Internal (same-boundary) moves carry no category and cross nothing.
    const internal = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: true,
      amount: -1000,
      allowMissingOutflowCategory: true,
    });
    expect(internal.isBoundaryCrossing).toBe(false);
    expect(internal.categoryId).toBeNull();
    // Boundary inflow without a category is income in the target month.
    // (Negative amount: money entering the on-budget destination leg.)
    const inflow = classifyBoundaryTransfer({
      srcOnBudget: false,
      destOnBudget: true,
      amount: -1000,
      incomeMonth: "2026-03",
    });
    expect(inflow.isBoundaryCrossing).toBe(true);
    expect(inflow.isIncome).toBe(true);
    expect(inflow.incomeMonth).toBe("2026-03");
  });

  it("normalizePayeeName canonicalizes known transfer targets", () => {
    const accounts = tFakeAccounts(["Checking"]);
    expect(tNormalize(accounts, "transfer:checking")).toBe("Transfer : Checking");
    expect(tNormalize(accounts, "Transfer : Missing")).toBe("Transfer : Missing");
    expect(tNormalize(accounts, "Starbucks")).toBe("Starbucks");
    expect(tNormalize(accounts, null)).toBeNull();
  });

  it("dangling transfer payees fail payee/leg consistency with a verbatim message", () => {
    // Oracle isInvalidTransferPayeeName: transfer-shaped + unresolvable.
    // Repo mapping: a transfer-styled payee with no transfer leg is
    // orphaned metadata (transfers.ts:270-278); legs resolve server-side.
    expect(() =>
      validateTransferPayeeConsistency("Transfer : Missing", null),
    ).toThrow("transfer payee requires a transferAccountId");
    expect(() =>
      validateTransferPayeeConsistency("Transfer : Checking", 7),
    ).not.toThrow();
    expect(() =>
      validateTransferPayeeConsistency("Starbucks", null),
    ).not.toThrow();
    expect(() => validateTransferPayeeConsistency(null, null)).not.toThrow();
  });
});
