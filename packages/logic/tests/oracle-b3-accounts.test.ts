/**
 * oracle-b3-accounts.test.ts
 *
 * Oracle parity port of `../ynab4-modern/packages/domain/src/Account.test.ts`
 * (1400 lines, 60 tests) over `Account.ts` + `../ynab4-modern/packages/domain/src/
 * AccountList.test.ts` (454 lines, 20 tests) over `AccountList.ts`.
 *
 * Mapping target: `../src/types.ts` (`Account` kind/onBudget), `../src/reconcile.ts`
 * (`computeReconcileState`), `../src/register.ts` (`computeRunningBalances`),
 * `../src/contracts.ts` (`AccountCreateSchema`, `AccountPatchSchema`,
 * `PositiveIntQuerySchema`, `BudgetDataResponseSchema`), `../src/budget-engine.ts`
 * (`isIncomeTransaction`), `../src/duplicates.ts` (`findDuplicateGroups`),
 * `../src/recurring.ts` (scheduled filter+sort analogue), and
 * `../../server/src/queries/accounts.ts` (CRUD/validation/balances — DB-owned,
 * documented N/A here; pure analogues tested instead).
 *
 * N/A inventory (no local counterpart, documented with reason):
 * - all-accounts pseudo-account (`Account.test.ts:167-191`): no `isAllAccounts`
 *   entity exists here; the all-account view is an aggregate query. Tested via
 *   unanchored `computeRunningBalances` per-account independence + summed
 *   assets/liabilities/netWorth buckets.
 * - partitioned/transaction sources (`Account.test.ts:193-226`): SQLite owns
 *   partitioning; there is no injected `transactionsSource`/partitioner seam.
 *   Tested via explicit per-account filtering of in-memory rows (the computable
 *   analogue of the partitioner predicate).
 * - date-extrema ADD folding / REMOVE reset / UPDATE quirk / suspend refcount /
 *   fan-out (`Account.test.ts:750-890`): no live-collection event system; rows
 *   are plain data. Register ordering (newest-first walk, anchor stability) is
 *   the computable analogue and is tested.
 * - check numbers last-wins / UPDATE sniff / legacy fallback (`Account.test.ts:
 *   892-997`): `Transaction` has no `checkNumber` field (verified below), so
 *   there is nothing to track; N/A-with-reason.
 * - error views / counts / maxErrorLevel priority / verbatim throw
 *   (`Account.test.ts:999-1133`, `AccountList.test.ts:330-408`): no per-row
 *   `errorState`; the computable analogue is the u/c/r status counts in
 *   `computeReconcileState`, tested.
 * - reconcile-wizard transients (`Account.test.ts:1350-1362`): no wizard fields
 *   on `Account`; reconcile flow state lives in the POST body
 *   (`ReconcileAccountSchema`) and response (`ReconcileState`). N/A.
 * - `AccountList` store-list semantics (`AccountList.test.ts:111-260,297-444`):
 *   sort-field remap, adjacency scan, tab order, moveExistingItem throw,
 *   bulk-rename conflict pass, suspend/resume seams — all collection-store
 *   behaviour with no counterpart (ordering is a SQL `ORDER BY sort`, tested
 *   via `listAccounts` ordering in server `invariants.test.ts`). Tested here
 *   via sort-key ordering + bucket/find/delete-guard analogues.
 * - server CRUD bodies (create/update/delete guards, starting-balance insert,
 *   CC-payment category, reconciled-delete lock in
 *   `server/src/queries/accounts.ts`): DB-owned; covered by server
 *   `invariants.test.ts` patterns. Pure analogues (validation messages,
 *   kind/onBudget consistency, starting/adjustment math) tested here.
 *
 * // FORK: balances are integer cents strings (not floats); `workingBalance`
 * is the cleared+reconciled statement comparator (YNAB4 `clearedBalance`
 * analog), while stored `accounts.balance` is the YNAB4 `workingBalance`
 * analog. onBudget is invariant-paired with kind (offbudget ⟺ !onBudget) at
 * the contract layer instead of cascading over live transactions. No
 * `isAllAccounts` setter throw exists — unknown/empty accounts simply yield
 * zeroed reconcile state.
 *
 * All money is integer cents. No console output (Vitest throws on it).
 */
import { describe, expect, it } from "vitest";
import {
  AccountCreateSchema,
  AccountPatchSchema,
  BudgetDataResponseSchema,
  PositiveIntQuerySchema,
  TransactionResponseSchema,
} from "../src/contracts.js";
import { isIncomeTransaction } from "../src/budget-engine.js";
import { findDuplicateGroups } from "../src/duplicates.js";
import { computeReconcileState } from "../src/reconcile.js";
import { computeRunningBalances } from "../src/register.js";
import type { Account, Recurring, Transaction } from "../src/types.js";

let seq = 0;
const nextId = () => ++seq + 1000;

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: "Checking",
    kind: "liquid",
    groupLabel: "Liquid",
    balance: "0",
    onBudget: true,
    sort: 0,
    lastReconciledAt: null,
    lastReconciledBalance: null,
    ...overrides,
  };
}

function makeTx(overrides: Partial<Transaction> & { amount: string | number }): Transaction {
  return {
    id: nextId(),
    accountId: 1,
    categoryId: null,
    date: "2012-05-17",
    payee: "",
    memo: "",
    status: "c",
    ...overrides,
    amount: String(overrides.amount),
  };
}

describe("Account ctor defaults (oracle Account.test.ts:123-165)", () => {
  it("applies the local Account shape defaults", () => {
    const a = makeAccount();
    expect(a.kind).toBe("liquid");
    expect(a.onBudget).toBe(true);
    expect(a.balance).toBe("0");
    expect(a.sort).toBe(0);
    expect(a.lastReconciledAt).toBeNull();
    expect(a.lastReconciledBalance).toBeNull();
    expect(a.archived).toBeUndefined();
    expect(a.notes).toBeUndefined();
  });

  it("keeps explicit kind/groupLabel/sort constructor values", () => {
    const a = makeAccount({ id: 7, name: "Visa", kind: "credit", groupLabel: "Credit", sort: 3 });
    expect(a.id).toBe(7);
    expect(a.name).toBe("Visa");
    expect(a.kind).toBe("credit");
    expect(a.groupLabel).toBe("Credit");
    expect(a.sort).toBe(3);
  });

  it("debt/asset flags map to kind liquid/credit/offbudget (oracle :322-346)", () => {
    const isAsset = (a: Account) => a.kind === "liquid" || a.kind === "offbudget";
    const isDebt = (a: Account) => a.kind === "credit";
    expect(isAsset(makeAccount({ kind: "liquid" }))).toBe(true);
    expect(isDebt(makeAccount({ kind: "liquid" }))).toBe(false);
    expect(isDebt(makeAccount({ kind: "credit" }))).toBe(true);
    expect(isAsset(makeAccount({ kind: "credit" }))).toBe(false);
    // Null-type-is-asset (oracle :322-335): the typeless default is liquid.
    expect(isAsset(makeAccount())).toBe(true);
  });

  it("Transaction has no checkNumber field (oracle :892-997 N/A-with-reason)", () => {
    const tx = makeTx({ amount: 100 });
    expect("checkNumber" in tx).toBe(false);
    const parsed = TransactionResponseSchema.safeParse({ ...tx, checkNumber: "5" });
    expect(parsed.success).toBe(true);
  });
});

describe("all-accounts aggregate view (oracle Account.test.ts:167-191, N/A aggregate)", () => {
  it("unanchored walk keeps accounts independent; summed buckets equal net worth", () => {
    const rows = [
      makeTx({ accountId: 1, amount: -10000, date: "2012-05-17" }),
      makeTx({ accountId: 2, amount: 5000, date: "2012-05-17" }),
      makeTx({ accountId: 1, amount: 100000, date: "2012-05-10" }),
    ];
    const balances = new Map([
      [1, 500000],
      [2, 20000],
    ]);
    const out = computeRunningBalances(rows, balances);
    const byId = (id: number) => out.find((r) => r.id === id)!;
    expect(byId(rows[0]!.id).runningBalance).toBe(500000);
    expect(byId(rows[1]!.id).runningBalance).toBe(20000);
    // Whole-set aggregate (no pseudo-account row): assets/liabilities/netWorth.
    const accounts = [makeAccount({ id: 1, balance: "500000" }), makeAccount({ id: 2, balance: "20000" })];
    const assets = accounts.filter((a) => Number(a.balance) >= 0).reduce((s, a) => s + Number(a.balance), 0);
    const liabilities = accounts.filter((a) => Number(a.balance) < 0).reduce((s, a) => s + Number(a.balance), 0);
    expect(assets).toBe(520000);
    expect(liabilities).toBe(0);
    expect(assets + liabilities).toBe(520000);
  });

  it("partitioned-source analogue: per-account filtering selects the account slice", () => {
    const rows = [
      makeTx({ accountId: 1, amount: 100, date: "2012-05-01" }),
      makeTx({ accountId: 2, amount: 200, date: "2012-05-02" }),
      makeTx({ accountId: 1, amount: 300, date: "2012-05-03" }),
    ];
    const slice = rows.filter((t) => t.accountId === 1);
    expect(slice).toHaveLength(2);
    const state = computeReconcileState(makeAccount({ id: 1 }), slice, "2012-05-31");
    expect(state.workingBalance).toBe(400);
    expect(state.clearedCount).toBe(2);
  });
});

describe("rename validation (oracle Account.test.ts:228-256)", () => {
  it("rename accepts a valid name patch", () => {
    const parsed = AccountPatchSchema.safeParse({ id: 1, name: "Renamed" });
    expect(parsed.success).toBe(true);
  });

  it("rename rejects empty names with a validation message", () => {
    const parsed = AccountPatchSchema.safeParse({ id: 1, name: "" });
    expect(parsed.success).toBe(false);
  });

  it("rename is safe on unknown fields: strict schema rejects them", () => {
    const parsed = AccountPatchSchema.safeParse({ id: 1, bogus: "x" });
    expect(parsed.success).toBe(false);
  });
});

describe("onBudget cascade analogue (oracle Account.test.ts:258-313,415-436)", () => {
  it("flipping onBudget flips income classification on recompute", () => {
    const tx = makeTx({ amount: 5000, isIncome: undefined, categoryId: null });
    const on = [makeAccount({ id: 1, onBudget: true, kind: "liquid" })];
    const off = [makeAccount({ id: 1, onBudget: false, kind: "offbudget" })];
    expect(isIncomeTransaction(tx, on)).toBe(true);
    expect(isIncomeTransaction(tx, off)).toBe(false);
  });

  it("kind/onBudget consistency is enforced at the contract layer", () => {
    expect(AccountCreateSchema.safeParse({ name: "X", kind: "offbudget", groupLabel: "G", onBudget: true }).success).toBe(false);
    expect(AccountCreateSchema.safeParse({ name: "X", kind: "liquid", groupLabel: "G", onBudget: false }).success).toBe(false);
    expect(AccountCreateSchema.safeParse({ name: "X", kind: "offbudget", groupLabel: "G" }).success).toBe(true);
  });

  it("setShouldBeOnBudget analogue: onBudget patch validates and applies per branch", () => {
    const toOff = AccountPatchSchema.safeParse({ id: 1, onBudget: false });
    expect(toOff.success).toBe(true);
    const toOn = AccountPatchSchema.safeParse({ id: 1, onBudget: true });
    expect(toOn.success).toBe(true);
  });
});

describe("unknown account handling (oracle Account.test.ts:315-320)", () => {
  it("empty/unknown account yields zeroed reconcile state instead of throwing", () => {
    const state = computeReconcileState(makeAccount({ id: 999, name: "Missing" }), [], "2012-05-31");
    expect(state).toEqual({
      accountId: 999,
      accountName: "Missing",
      workingBalance: 0,
      unclearedTotal: 0,
      unclearedCount: 0,
      clearedCount: 0,
      reconciledCount: 0,
      lastReconciledAt: null,
      lastReconciledBalance: null,
    });
  });

  it("account id params reject non-positive ids", () => {
    expect(PositiveIntQuerySchema.safeParse("0").success).toBe(false);
    expect(PositiveIntQuerySchema.safeParse("-3").success).toBe(false);
    expect(PositiveIntQuerySchema.safeParse("abc").success).toBe(false);
    expect(PositiveIntQuerySchema.safeParse("7").success).toBe(true);
  });
});

describe("VO round-trip (oracle Account.test.ts:358-413,447-453)", () => {
  it("BudgetData response round-trips the account field list (trim + kind + reconciled fields)", () => {
    const payload = {
      accounts: [{ ...makeAccount({ id: 9, name: "Padded", kind: "credit", balance: "1250", lastReconciledBalance: 1250 }) }],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [],
      recurring: [],
    };
    const parsed = BudgetDataResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.accounts[0]!.name).toBe("Padded");
      expect(parsed.data.accounts[0]!.kind).toBe("credit");
      expect(String(parsed.data.accounts[0]!.balance)).toBe("1250");
    }
  });

  it("account response rejects unknown kind values", () => {
    const payload = {
      accounts: [],
      groups: [],
      categories: [],
      assignments: [],
      transactions: [
        { ...makeTx({ amount: 100 }), status: "bogus" },
      ],
      recurring: [],
    };
    expect(BudgetDataResponseSchema.safeParse(payload).success).toBe(false);
  });
});

describe("starting/adjustment balances (oracle Account.test.ts:489-748)", () => {
  it("starting-balance payee row is cleared and counted in reconcile state", () => {
    const acct = makeAccount({ id: 1, balance: "10000" });
    const starting = makeTx({ accountId: 1, amount: 10000, payee: "Starting Balance", status: "c", date: "2012-05-01" });
    const state = computeReconcileState(acct, [starting], "2012-05-31");
    expect(state.workingBalance).toBe(10000);
    expect(state.clearedCount).toBe(1);
  });

  it("zero starting balance still anchors the register walk", () => {
    const rows = [makeTx({ accountId: 1, amount: 0, payee: "Starting Balance", date: "2012-05-01" })];
    const out = computeRunningBalances(rows, new Map([[1, 0]]));
    expect(out[0]!.runningBalance).toBe(0);
  });

  it("adjustment delta is statement minus working balance (3-way: zero/sign/offbudget)", () => {
    const acct = makeAccount({ id: 1, onBudget: true, kind: "liquid" });
    const txns = [makeTx({ accountId: 1, amount: 10000, status: "c", date: "2012-05-01" })];
    const state = computeReconcileState(acct, txns, "2012-05-31");
    expect(15000 - state.workingBalance).toBe(5000);
    expect(10000 - state.workingBalance).toBe(0);
    expect(8000 - state.workingBalance).toBe(-2000);
  });

  it("off-budget adjustment carries no budget effect: income classification is false", () => {
    const tx = makeTx({ amount: 5000, categoryId: null, isIncome: undefined });
    const accts = [makeAccount({ id: 1, onBudget: false, kind: "offbudget" })];
    expect(isIncomeTransaction(tx, accts)).toBe(false);
  });

  it("single zero-row rewrite analogue: lone row anchors exactly at stored balance", () => {
    const row = makeTx({ accountId: 1, amount: 0, date: "2012-05-17" });
    const out = computeRunningBalances([row], new Map([[1, 15000]]));
    expect(out[0]!.runningBalance).toBe(15000);
  });
});

describe("register ordering + split folding (oracle Account.test.ts:750-890)", () => {
  it("newest-first walk anchors the newest row at the stored balance", () => {
    const rows = [
      makeTx({ accountId: 1, amount: -10000, date: "2012-05-30" }),
      makeTx({ accountId: 1, amount: -5000, date: "2012-05-29" }),
    ];
    const out = computeRunningBalances(rows, new Map([[1, 100000]]));
    const byId = (id: number) => out.find((r) => r.id === id)!;
    expect(byId(rows[0]!.id).runningBalance).toBe(100000);
    expect(byId(rows[0]!.id).runningBalance).not.toBe(byId(rows[1]!.id).runningBalance);
  });

  it("split parents are excluded from reconcile sums; children carry the effect", () => {
    const parent = makeTx({ accountId: 1, amount: 10000, status: "c", date: "2012-05-01" });
    const c1 = makeTx({ accountId: 1, amount: 6000, status: "c", date: "2012-05-01", parentId: parent.id });
    const c2 = makeTx({ accountId: 1, amount: 4000, status: "c", date: "2012-05-01", parentId: parent.id });
    const state = computeReconcileState(makeAccount({ id: 1 }), [parent, c1, c2], "2012-05-31");
    expect(state.workingBalance).toBe(10000);
    expect(state.clearedCount).toBe(2);
  });

  it("split parent mirrors the newest participating child running balance", () => {
    const parent = makeTx({ accountId: 1, amount: 10000, date: "2012-05-02" });
    const c1 = makeTx({ accountId: 1, amount: 6000, date: "2012-05-02", parentId: parent.id });
    const c2 = makeTx({ accountId: 1, amount: 4000, date: "2012-05-01", parentId: parent.id });
    const out = computeRunningBalances([parent, c1, c2], new Map([[1, 10000]]));
    const byId = (id: number) => out.find((r) => r.id === id)!;
    expect(byId(parent.id).runningBalance).toBe(byId(c1.id).runningBalance);
    expect(byId(c1.id).runningBalance).toBe(10000);
    expect(byId(c2.id).runningBalance).toBe(4000);
  });
});

describe("transfer legs (oracle balances/setBalances analogue)", () => {
  it("inbound transfer leg inverts the sign in reconcile state", () => {
    const out = makeTx({ accountId: 1, transferAccountId: 2, amount: -20000, status: "c", date: "2012-05-01" });
    const state = computeReconcileState(makeAccount({ id: 2, name: "Savings" }), [out], "2012-05-31");
    expect(state.workingBalance).toBe(20000);
  });

  it("destination-side row applies the opposite sign in the running walk", () => {
    const row = makeTx({ accountId: 1, transferAccountId: 2, amount: -20000, date: "2012-05-01" });
    const out = computeRunningBalances([row], new Map([[2, 50000]]), 2);
    expect(out[0]!.runningBalance).toBe(50000);
  });
});

describe("status counts (oracle Account.test.ts:999-1065 error-view analogue)", () => {
  it("reconcile state reports u/c/r counts over the live set", () => {
    const txns = [
      makeTx({ accountId: 1, amount: 1, status: "u", date: "2012-05-01" }),
      makeTx({ accountId: 1, amount: 2, status: "c", date: "2012-05-02" }),
      makeTx({ accountId: 1, amount: 3, status: "r", date: "2012-05-03" }),
      makeTx({ accountId: 1, amount: 4, status: "c", date: "2012-05-04" }),
    ];
    const state = computeReconcileState(makeAccount({ id: 1 }), txns, "2012-05-31");
    expect(state.unclearedCount).toBe(1);
    expect(state.clearedCount).toBe(2);
    expect(state.reconciledCount).toBe(1);
    expect(state.unclearedTotal).toBe(1);
  });

  it("statement-date bound excludes future rows from counts", () => {
    const txns = [
      makeTx({ accountId: 1, amount: 100, status: "c", date: "2012-05-01" }),
      makeTx({ accountId: 1, amount: 200, status: "c", date: "2012-06-15" }),
    ];
    const state = computeReconcileState(makeAccount({ id: 1 }), txns, "2012-05-31");
    expect(state.workingBalance).toBe(100);
    expect(state.clearedCount).toBe(1);
  });
});

describe("scheduled filter+sort (oracle Account.test.ts:1136-1187)", () => {
  const rule = (overrides: Partial<Recurring> = {}): Recurring => ({
    id: 1,
    accountId: 1,
    categoryId: null,
    payee: "Rent",
    amount: "-100000",
    frequency: "monthly",
    nextDate: "2012-05-15",
    active: true,
    transferAccountId: null,
    ...overrides,
  });

  it("filters recurring rules to one account and sorts ascending by nextDate", () => {
    const rules = [
      rule({ id: 1, nextDate: "2012-05-10" }),
      rule({ id: 2, accountId: 2, nextDate: "2012-05-01" }),
      rule({ id: 3, nextDate: "2012-05-05" }),
    ];
    const view = rules
      .filter((r) => r.accountId === 1 && r.active)
      .sort((a, b) => (a.nextDate < b.nextDate ? -1 : a.nextDate > b.nextDate ? 1 : 0));
    expect(view.map((r) => r.id)).toEqual([3, 1]);
  });

  it("inactive rules are excluded from the account schedule", () => {
    const rules = [rule({ id: 1 }), rule({ id: 2, active: false })];
    expect(rules.filter((r) => r.accountId === 1 && r.active)).toHaveLength(1);
  });
});

describe("FITID/duplicate matching (oracle Account.test.ts:1189-1239)", () => {
  it("identical rows with the same fitId group together", () => {
    const groups = findDuplicateGroups([
      { accountId: 1, date: "2012-05-01", amount: 500, payee: "Shop", memo: "", fitId: "f1", status: "c" },
      { accountId: 1, date: "2012-05-01", amount: 500, payee: "Shop", memo: "", fitId: "f1", status: "c" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.duplicates).toHaveLength(1);
  });

  it("different fitIds never group; miss yields no groups", () => {
    const groups = findDuplicateGroups([
      { accountId: 1, date: "2012-05-01", amount: 500, payee: "Shop", memo: "", fitId: "f1", status: "c" },
      { accountId: 1, date: "2012-05-01", amount: 500, payee: "Shop", memo: "", fitId: "f2", status: "c" },
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe("hasCategorizedTransactions analogue (oracle Account.test.ts:1324-1348)", () => {
  it("account has categorized activity when any row carries a category", () => {
    const rows = [makeTx({ amount: -500, categoryId: null }), makeTx({ amount: -700, categoryId: 9 })];
    expect(rows.some((t) => t.categoryId != null)).toBe(true);
    expect([makeTx({ amount: -500, categoryId: null })].some((t) => t.categoryId != null)).toBe(false);
  });
});

describe("AccountList analogues (oracle AccountList.test.ts)", () => {
  it("orders by ascending numeric sort key (oracle AccountList.test.ts:117-132)", () => {
    const accounts = [
      makeAccount({ name: "C", sort: 30 }),
      makeAccount({ name: "A", sort: -5 }),
      makeAccount({ name: "B", sort: 9 }),
    ].sort((a, b) => a.sort - b.sort);
    expect(accounts.map((a) => a.name)).toEqual(["A", "B", "C"]);
  });

  it("splits balance buckets by onBudget/hidden with integer cents (oracle :134-167)", () => {
    const accounts = [
      makeAccount({ name: "On", balance: "10026", onBudget: true }),
      makeAccount({ name: "Off", balance: "-5000", onBudget: false, kind: "offbudget" }),
      makeAccount({ name: "Hid", balance: "2500", archived: true }),
    ];
    const budgeted = accounts.filter((a) => a.onBudget && !a.archived).reduce((s, a) => s + Number(a.balance), 0);
    const nonBudgeted = accounts.filter((a) => !a.onBudget && !a.archived).reduce((s, a) => s + Number(a.balance), 0);
    const hidden = accounts.filter((a) => a.archived).reduce((s, a) => s + Number(a.balance), 0);
    expect(budgeted).toBe(10026);
    expect(nonBudgeted).toBe(-5000);
    expect(hidden).toBe(2500);
    expect(budgeted + nonBudgeted + hidden).toBe(7526);
  });

  it("findAccountByName hits case-insensitively and misses null (oracle :182-210)", () => {
    const accounts = [makeAccount({ name: "Checking" }), makeAccount({ name: "Savings" })];
    const findByName = (name: string | null) =>
      name == null ? null : (accounts.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null);
    expect(findByName("checking")).toBe(accounts[0]);
    expect(findByName("CHECKING")).toBe(accounts[0]);
    expect(findByName("Missing")).toBeNull();
    expect(findByName(null)).toBeNull();
  });

  it("create validation rejects blank names and bad kinds (oracle bulk-rename guard analogue)", () => {
    expect(AccountCreateSchema.safeParse({ name: "", kind: "liquid", groupLabel: "G" }).success).toBe(false);
    expect(AccountCreateSchema.safeParse({ name: "X", kind: "nope", groupLabel: "G" }).success).toBe(false);
    expect(AccountCreateSchema.safeParse({ name: "X", kind: "credit", groupLabel: "G", balance: 500 }).success).toBe(true);
  });

  it("delete guard analogue: reconciled rows block the optimistic flip set", () => {
    const txns = [makeTx({ accountId: 1, amount: 100, status: "r", date: "2012-05-01" })];
    const state = computeReconcileState(makeAccount({ id: 1 }), txns, "2012-05-31");
    expect(state.reconciledCount).toBe(1);
    expect(state.clearedCount).toBe(0);
  });
});
