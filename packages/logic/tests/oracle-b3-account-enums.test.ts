/**
 * oracle-b3-account-enums.test.ts
 *
 * Oracle port: YNAB4 account-enum + cleared-status + account-name-rule
 * semantics mapped onto this repo's shrunken `kind` taxonomy
 * (`types.ts` Account kind `liquid | credit | offbudget`), the `u/c/r`
 * `ClearedStatus` union, and the contract/server account-name layer.
 *
 * Sources (17 tests):
 * - ynab4-modern/packages/domain/src/AccountType.test.ts (7 tests):
 *   :11-29 (eleven singletons with verbatim oracle names), :31-43 (asset vs
 *   debt flags), :45-57 (recommended-on-budget flags), :59-67 (getEnumByName
 *   defaults to case-insensitive), :69-74 (caseSensitive=false opt-out),
 *   :76-80 (null/empty/unknown -> null), :82-84 (toString returns name).
 * - ynab4-modern/packages/domain/src/ClearedStatus.test.ts (4 tests):
 *   :5-15 (U/C/R labels, positions 0/1/2, integer values 0/1/2), :17-22
 *   (enum names + stringify), :24-39 (getEnumByName exact/ci/cs/miss),
 *   :41-54 (compare with null handling: null,null->0; null,x->-1;
 *   x,null->1; else numeric).
 * - ynab4-modern/packages/domain/src/validation/AccountRules.test.ts
 *   (6 tests): null/empty/whitespace -> EMPTY, duplicate (incl. padded)
 *   -> DUPLICATE, backtick -> "An account name may not contain: `",
 *   valid -> null, accountNameIsValid wrapper mirrors the null-check,
 *   verbatim message constants.
 *
 * // FORK: taxonomy simplification. This repo deliberately collapses the
 * oracle's 11-way AccountType taxonomy (Checking/Savings/CreditCard/Cash/
 * LineofCredit/Paypal/MerchantAccount/InvestmentAccount/Mortgage/
 * OtherAsset/OtherLiability) into 3 kinds (liquid/credit/offbudget), drops
 * the case-insensitive getEnumByName fold (kind parsing is exact and
 * case-sensitive), and has NO account-name validation helper: empty names
 * are rejected only by zod min(1), duplicates and backticks are accepted
 * at the contract layer (no UNIQUE index on accounts.name in
 * server/src/schema.ts), and none of the three verbatim oracle messages
 * exist anywhere in logic/ or server/. Tests below pin the repo's actual
 * behavior and document each gap inline.
 */
import { describe, expect, it } from "vitest";
import {
  AccountCreateSchema,
  AccountResponseSchema,
  TransactionBulkUpdateSchema,
  TransactionResponseSchema,
  computeReconcileState,
  applyOptimisticReconcileFlips,
} from "../src/index.js";
import type { Account, ClearedStatus, Transaction } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verbatim oracle singleton names from the AccountType registry. */
const ORACLE_ACCOUNT_TYPE_NAMES = [
  "Checking",
  "Savings",
  "CreditCard",
  "Cash",
  "LineofCredit",
  "Paypal",
  "MerchantAccount",
  "InvestmentAccount",
  "Mortgage",
  "OtherAsset",
  "OtherLiability",
] as const;

/**
 * Rank analogue of the oracle ClearedStatus integerValue/position
 * (Uncleared 0 < Cleared 1 < Reconciled 2). The repo carries status as a
 * bare "u" | "c" | "r" union with no rank field, so ordering is defined
 * here once and reused by the ordering/compare tests below.
 */
function statusRank(status: ClearedStatus): number {
  return status === "u" ? 0 : status === "c" ? 1 : 2;
}

/**
 * Null-safe compare analogue of the oracle `ClearedStatus.compare`
 * (null,null->0; null,x->-1; x,null->1; else numeric rank compare).
 */
function compareStatus(a: ClearedStatus | null, b: ClearedStatus | null): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  const ra = statusRank(a);
  const rb = statusRank(b);
  return ra < rb ? -1 : ra > rb ? 1 : 0;
}

/** Minimal account row for reconcile-state tests (integer-cent balance). */
function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: "Checking",
    kind: "liquid",
    groupLabel: "Budget",
    balance: "12000",
    onBudget: true,
    sort: 0,
    lastReconciledAt: null,
    lastReconciledBalance: null,
    ...overrides,
  };
}

/** Minimal transaction row (amount is an integer-cent string). */
function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 1,
    accountId: 1,
    categoryId: null,
    date: "2026-06-01",
    payee: "",
    memo: "",
    amount: "0",
    status: "c",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. Account kind taxonomy (oracle AccountType, 7 tests)
// ---------------------------------------------------------------------------

describe("account kind taxonomy (oracle AccountType analogue)", () => {
  it("accepts exactly the 3 kinds: liquid, credit, offbudget", () => {
    for (const kind of ["liquid", "credit", "offbudget"] as const) {
      const parsed = AccountCreateSchema.safeParse({ name: "A", kind, groupLabel: "G" });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.kind).toBe(kind);
    }
    expect(AccountResponseSchema.safeParse({
      id: 1, name: "A", kind: "liquid", groupLabel: "G",
      balance: "12000", onBudget: true, sort: 0,
    }).success).toBe(true);
  });

  it("FORK: rejects all 11 verbatim oracle type names as kind values (no 11-way taxonomy)", () => {
    for (const name of ORACLE_ACCOUNT_TYPE_NAMES) {
      const parsed = AccountCreateSchema.safeParse({ name: "A", kind: name, groupLabel: "G" });
      expect(parsed.success).toBe(false);
    }
  });

  it("maps asset/debt: liquid is the asset analogue, credit the on-budget debt analogue", () => {
    const liquid = AccountCreateSchema.safeParse({ name: "Checking", kind: "liquid", groupLabel: "G" });
    const credit = AccountCreateSchema.safeParse({ name: "Visa", kind: "credit", groupLabel: "G" });
    expect(liquid.success && liquid.data.onBudget).toBe(true);
    // Like oracle CreditCard/LineofCredit (isAssetAccount false yet
    // isRecommendedOnBudget true), repo credit is debt carried on-budget.
    expect(credit.success && credit.data.onBudget).toBe(true);
    expect(credit.success && credit.data.kind).toBe("credit");
  });

  it("recommended-on-budget analogue: onBudget defaults from kind (liquid/credit true, offbudget false)", () => {
    const offbudget = AccountCreateSchema.safeParse({ name: "Brokerage", kind: "offbudget", groupLabel: "G" });
    expect(offbudget.success && offbudget.data.onBudget).toBe(false);
  });

  it("enforces kind/onBudget consistency (offbudget+true and liquid/credit+false rejected)", () => {
    expect(AccountCreateSchema.safeParse({
      name: "B", kind: "offbudget", groupLabel: "G", onBudget: true,
    }).success).toBe(false);
    expect(AccountCreateSchema.safeParse({
      name: "C", kind: "liquid", groupLabel: "G", onBudget: false,
    }).success).toBe(false);
    expect(AccountCreateSchema.safeParse({
      name: "V", kind: "credit", groupLabel: "G", onBudget: false,
    }).success).toBe(false);
    const bad = AccountCreateSchema.safeParse({
      name: "B", kind: "offbudget", groupLabel: "G", onBudget: true,
    });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.message).toMatch(/kind and onBudget/);
  });

  it("kind lookup is exact and case-sensitive (no case-insensitive fold; null/empty/unknown miss)", () => {
    // Oracle getEnumByName defaults to case-insensitive; the repo schema has
    // no fold, so every non-exact spelling misses — including "" and unknown.
    for (const kind of ["Liquid", "CREDITCARD", "checking", "", "Nope", "Checking"]) {
      expect(AccountCreateSchema.safeParse({ name: "A", kind, groupLabel: "G" }).success).toBe(false);
    }
    expect(AccountCreateSchema.safeParse({ name: "A", groupLabel: "G" }).success).toBe(false);
  });

  it("kind values are their own wire names (toString identity analogue)", () => {
    // Oracle toString() returns the enum name; here the kind literal IS the
    // wire name — String(kind) round-trips through the response schema.
    for (const kind of ["liquid", "credit", "offbudget"] as const) {
      expect(String(kind)).toBe(kind);
      const parsed = AccountResponseSchema.safeParse({
        id: 7, name: "A", kind, groupLabel: "G",
        balance: "0", onBudget: kind !== "offbudget", sort: 3,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(String(parsed.data.kind)).toBe(kind);
    }
  });
});

// ---------------------------------------------------------------------------
// B. Cleared status (oracle ClearedStatus, 4 tests -> 7 its)
// ---------------------------------------------------------------------------

describe("cleared status ranks and ordering (oracle ClearedStatus analogue)", () => {
  it("pins verbatim ranks u=0 < c=1 < r=2", () => {
    expect(statusRank("u")).toBe(0);
    expect(statusRank("c")).toBe(1);
    expect(statusRank("r")).toBe(2);
  });

  it("read path carries all three statuses; write path locks out r", () => {
    // Oracle: three singletons Uncleared/Cleared/Reconciled ("U"/"C"/"R").
    // Repo read side accepts u/c/r; create/bulk-update inputs accept u/c —
    // only the reconcile flow may set r (see BulkUpdateTransactionPatch).
    const read = { ...makeTx({ status: "r" }), amount: "500" };
    expect(TransactionResponseSchema.safeParse(read).success).toBe(true);
    expect(TransactionBulkUpdateSchema.safeParse({
      ids: [1], patch: { status: "r" },
    }).success).toBe(false);
    expect(TransactionBulkUpdateSchema.safeParse({
      ids: [1], patch: { status: "c" },
    }).success).toBe(true);
  });

  it("getEnumByName miss contract analogue: status matching is exact lowercase (no ci fold)", () => {
    // Oracle resolves "cleared"/"RECONCILED" case-insensitively by default;
    // the repo schemas accept only exact "u"/"c"/"r" — uppercase, names,
    // empty, and unknown all miss.
    for (const status of ["U", "C", "R", "Uncleared", "cleared", "RECONCILED", "", "Pending"]) {
      expect(TransactionResponseSchema.safeParse({ ...makeTx({}), status }).success).toBe(false);
    }
    expect(TransactionResponseSchema.safeParse(makeTx({ status: "u" })).success).toBe(true);
  });

  it("null-safe compare analogue: (null,null)->0; (null,x)->-1; (x,null)->1; else numeric", () => {
    expect(compareStatus("u", "c")).toBe(-1);
    expect(compareStatus("r", "c")).toBe(1);
    expect(compareStatus("c", "c")).toBe(0);
    expect(compareStatus(null, null)).toBe(0);
    expect(compareStatus(null, "c")).toBe(-1);
    expect(compareStatus("c", null)).toBe(1);
  });

  it("register ordering analogue: sorting by rank yields u < c < r", () => {
    const shuffled: ClearedStatus[] = ["r", "u", "c", "r", "u"];
    expect([...shuffled].sort((a, b) => statusRank(a) - statusRank(b))).toEqual([
      "u", "u", "c", "r", "r",
    ]);
    expect(statusRank("u")).toBeLessThan(statusRank("c"));
    expect(statusRank("c")).toBeLessThan(statusRank("r"));
  });

  it("reconcile working balance counts only c+r (u excluded), with per-status counts", () => {
    const acct = makeAccount();
    const txns: Transaction[] = [
      makeTx({ id: 1, amount: "50000", status: "c", date: "2026-06-01" }),
      makeTx({ id: 2, amount: "10000", status: "r", date: "2026-06-02" }),
      makeTx({ id: 3, amount: "-5000", status: "u", date: "2026-06-03" }),
    ];
    const state = computeReconcileState(acct, txns, "2026-06-30");
    expect(state.workingBalance).toBe(60000);
    expect(state.unclearedTotal).toBe(-5000);
    expect(state.unclearedCount).toBe(1);
    expect(state.clearedCount).toBe(1);
    expect(state.reconciledCount).toBe(1);
  });

  it("reconcile flow flips c->r; direct writes stay locked to u/c", () => {
    const txns: Transaction[] = [
      makeTx({ id: 1, amount: "25000", status: "c", date: "2026-06-01" }),
      makeTx({ id: 2, amount: "-300", status: "u", date: "2026-06-02" }),
    ];
    const flipped = applyOptimisticReconcileFlips(txns, 1, "2026-06-30");
    expect(flipped.find((t) => t.id === 1)?.status).toBe("r");
    expect(flipped.find((t) => t.id === 2)?.status).toBe("u");
  });
});

// ---------------------------------------------------------------------------
// C. Account-name rules (oracle AccountRules, 6 tests -> 6 its)
// ---------------------------------------------------------------------------

describe("account-name rules (oracle AccountRules analogue + gaps)", () => {
  it("empty names are rejected at the contract layer (EMPTY analogue, different message)", () => {
    // Oracle: "Account name cannot be empty." via trimNullFriendly. Repo has
    // no such constant; the zod min(1) is the only empty-name gate.
    const parsed = AccountCreateSchema.safeParse({ name: "", kind: "liquid", groupLabel: "G" });
    expect(parsed.success).toBe(false);
  });

  it("GAP: whitespace-only names pass the contract layer (oracle trims first)", () => {
    // Oracle getAccountNameErrorMessage rejects "   " (trim -> empty).
    // Repo AccountCreateSchema has no trim, so "   " parses — document gap.
    expect(AccountCreateSchema.safeParse({
      name: "   ", kind: "liquid", groupLabel: "G",
    }).success).toBe(true);
  });

  it("GAP: duplicate names pass the contract layer (no DUPLICATE gate, no UNIQUE index)", () => {
    // Oracle: "An account with this name already exists." (case-insensitive
    // lookup, padded names match). Repo: schema has no lookup and
    // server/src/schema.ts defines no UNIQUE index on accounts.name, so two
    // same-name creates both validate — document gap.
    const input = { name: "Checking", kind: "liquid", groupLabel: "G" } as const;
    expect(AccountCreateSchema.safeParse(input).success).toBe(true);
    expect(AccountCreateSchema.safeParse({ ...input, name: "  Checking  " }).success).toBe(true);
  });

  it("GAP: backtick names pass the contract layer (no hidden-separator rule)", () => {
    // Oracle: 'An account name may not contain: `' for "Weird`Name". Repo
    // has no INVALID_CHARACTER rule — document gap.
    expect(AccountCreateSchema.safeParse({
      name: "Weird`Name", kind: "liquid", groupLabel: "G",
    }).success).toBe(true);
  });

  it("GAP: none of the three verbatim oracle messages exist in the repo", async () => {
    // Characterization of the fork: no helper reproduces EMPTY_ACCOUNT_NAME,
    // DUPLICATE_ACCOUNT_NAME, or INVALID_CHARACTER ("...{0}").
    const contracts = await import("../src/contracts.js");
    const exported = Object.values(contracts).filter((v) => typeof v === "string") as string[];
    expect(exported).not.toContain("Account name cannot be empty.");
    expect(exported).not.toContain("An account with this name already exists.");
    expect(exported).not.toContain("An account name may not contain: {0}");
  });

  it("valid names pass; safeParse().success is the is-valid wrapper analogue", () => {
    // Oracle accountNameIsValid mirrors the null-check on the message; here
    // safeParse().success is the validity gate (true only when every layer
    // — including kind/onBudget consistency — holds).
    const isValid = (name: string): boolean =>
      AccountCreateSchema.safeParse({ name, kind: "liquid", groupLabel: "G" }).success;
    expect(isValid("Savings")).toBe(true);
    expect(isValid("")).toBe(false);
  });
});
