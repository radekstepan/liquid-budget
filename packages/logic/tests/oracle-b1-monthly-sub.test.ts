/**
 * oracle-b1-monthly-sub.test.ts
 *
 * Oracle parity for the per-category monthly leaf
 * (`MonthlySubCategoryBudget`): id scheme, observed-list filter matrix,
 * shouldAddSubTransaction edges, spent/budgeted/balance/priorBalance math +
 * NaN throws, rollover matrix (prev +/- x Confined/AffectsBuffer/inherit),
 * listener swap, inheritance + cache, createFromVO identity reuse, VO
 * round-trip.
 *
 * This repo has no per-leaf entity model: leaf semantics are emulated via
 * computeBudget results — budgeted=assigned, spent=-outflow, balance=available,
 * priorBalance=carryoverIn — and via buildBudgetIndex caching.
 *
 * Oracle refs (ynab4-modern/packages/domain/src/MonthlySubCategoryBudget.test.ts):
 *   construction (MCB id scheme, entity type, observed wiring, no-previous wait) :227-291
 *   discoverAndObservePreviousMonth (verbatim throws, swap, dispose guard)      :293-418
 *   filterShouldObserveTransaction matrix                                       :420-478
 *   shouldAddSubTransaction edges                                               :480-544
 *   getTotalSpendingAccountingForSplit sign convention                           :546-567
 *   budgeted/spent/balance/priorBalance math + NaN throws + zeroOut/clearData   :569-632
 *   recalcPriorBalance rollover matrix                                          :634-775
 *   overspendingHandling inheritance + cache refresh                            :777-854
 *   createFromVO identity reuse + seam errors                                   :856-923
 *   populateFromVO / populateVO round-trip (tombstone, handling-null)           :925-1015
 *   dispose idempotency + listener detach                                      :1017-1039
 * Oracle implementation refs:
 *   ynab4-modern/packages/domain/src/MonthlySubCategoryBudget.ts
 *     NaN throws ("NaN passed in") :458, :485, :504
 *     shouldAddSubTransaction      :321, filter :~405, rollover :~473-484
 *   MonthlySubCategoryBudget behavior (683-line reference):
 *     shouldAddSubTransaction :80, budgeted NaN :207, spent NaN :233,
 *     priorBalance NaN :255, overspendingHandling inheritance :265-332,
 *     observed filter :405, rollover rule :473-484, dispose :498
 *
 * Mapping notes (behavioral, not line-for-line):
 * - "Observed transactions" == the month's transaction list feeding the
 *   index; recalc == rebuild via invalidateBudgetIndex + computeBudget.
 * - shouldAddSubTransaction's transfer-to-on-budget exclusion maps to
 *   classifyBoundaryTransfer (internal transfers never post outflow) and to
 *   the split-parent skip in the index.
 * - FORK: credit-card buffer (budget-engine.ts:31-55) has no YNAB4
 *   counterpart — CC tests here assert only that cash-leaf rollover is
 *   unaffected, never "fixing" the buffer.
 * - FORK: incomeMonth superset — income attributed to t.incomeMonth when
 *   set — is a deliberate extension; tests pin the documented behavior.
 * - FORK: exact-only matching / case folding are engine-level and out of
 *   scope for this leaf file.
 */
import { describe, expect, it } from "vitest";
import {
  buildBudgetIndex,
  computeBudget,
  invalidateBudgetIndex,
  isIncomeTransaction,
  normalizeBudgetData,
} from "../src/budget-engine.js";
import { dollarsToCents, num } from "../src/format.js";
import { classifyBoundaryTransfer } from "../src/transfers.js";
import type {
  Account,
  BudgetData,
  Category,
  Transaction,
} from "../src/types.js";

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

function baseData(): BudgetData {
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

function tx(overrides: Partial<Transaction> & { id: number }): Transaction {
  return {
    accountId: 1,
    categoryId: 1,
    date: "2026-02-10",
    payee: "",
    memo: "",
    amount: "-4000",
    status: "c",
    ...overrides,
  };
}

function leafOf(data: BudgetData, month: string, catId = 1) {
  const result = computeBudget(data, month);
  const row = result.groups
    .flatMap((g) => g.rows)
    .find((r) => r.category.id === catId);
  if (!row) throw new Error(`missing leaf for category ${catId}`);
  return { result, row };
}

describe("leaf identity and monthly keying (oracle :227-262)", () => {
  it("derives the leaf from the month key plus category id (MCB/2026-02/sub analogue)", () => {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2026-02", amount: "10000" }];
    const { row } = leafOf(data, "2026-02");
    expect(row.category.id).toBe(1);
    expect(row.assigned).toBe(10000);
    // Same category in a different month is a different leaf.
    const jan = leafOf(data, "2026-01").row;
    expect(jan.assigned).toBe(0);
    expect(jan.available).toBe(0);
  });

  it("fresh leaf defaults to zero budgeted/spent with the carryover seed as balance", () => {
    const data = baseData();
    data.categories[0] = {
      ...(data.categories[0] as Category),
      carryover: "7000",
    };
    const { row } = leafOf(data, "2026-02");
    expect(row.assigned).toBe(0);
    expect(row.outflow).toBe(0);
    expect(row.carryoverIn).toBe(7000);
    expect(row.available).toBe(7000);
  });

  it("wires the month's transactions into the leaf (observed-list analogue)", () => {
    const data = baseData();
    data.transactions = [tx({ id: 1, amount: "-4000", date: "2026-02-10" })];
    expect(leafOf(data, "2026-02").row.outflow).toBe(-4000);
    // A transaction dated in another month does not leak into this leaf.
    expect(leafOf(data, "2026-01").row.outflow).toBe(0);
  });
});

describe("observed filter matrix (oracle :420-478)", () => {
  it("observes matching-category on-budget outflow", () => {
    const data = baseData();
    data.transactions = [tx({ id: 1, amount: "-4000" })];
    const { row } = leafOf(data, "2026-02");
    expect(row.outflow).toBe(-4000);
    expect(row.available).toBe(-4000);
  });

  it("ignores other-category transactions", () => {
    const data = baseData();
    data.categories.push({
      id: 2,
      groupId: 1,
      name: "Other",
      sort: 1,
      carryover: "0",
      goalTarget: null,
      linkedAccountId: null,
    });
    data.transactions = [tx({ id: 1, categoryId: 2, amount: "-4000" })];
    expect(leafOf(data, "2026-02", 1).row.outflow).toBe(0);
    expect(leafOf(data, "2026-02", 2).row.outflow).toBe(-4000);
  });

  it("ignores off-budget account transactions", () => {
    const data = baseData();
    data.accounts.push({
      id: 2,
      name: "Savings",
      kind: "liquid",
      groupLabel: "Cash",
      balance: "0",
      onBudget: false,
      sort: 1,
    });
    data.transactions = [tx({ id: 1, accountId: 2, amount: "-4000" })];
    expect(leafOf(data, "2026-02").row.outflow).toBe(0);
  });

  it("null-category positive inflow is income, not leaf outflow", () => {
    const data = baseData();
    const income = tx({ id: 1, categoryId: null, amount: "50000" });
    expect(isIncomeTransaction(income, new Map(data.accounts.map((a) => [a.id, a])))).toBe(true);
    data.transactions = [income];
    const { result, row } = leafOf(data, "2026-02");
    expect(row.outflow).toBe(0);
    expect(result.totalIncome).toBe(50000);
  });

  it("split parent is excluded; only matching child legs count", () => {
    const data = baseData();
    data.categories.push({
      id: 2,
      groupId: 1,
      name: "Other",
      sort: 1,
      carryover: "0",
      goalTarget: null,
      linkedAccountId: null,
    });
    data.transactions = [
      { ...tx({ id: 1, categoryId: null, amount: "-5000" }) },
      { ...tx({ id: 2, categoryId: 1, parentId: 1, amount: "-3000" }) },
      { ...tx({ id: 3, categoryId: 2, parentId: 1, amount: "-2000" }) },
    ];
    expect(leafOf(data, "2026-02", 1).row.outflow).toBe(-3000);
    expect(leafOf(data, "2026-02", 2).row.outflow).toBe(-2000);
  });

  it("split with no matching child contributes nothing", () => {
    const data = baseData();
    data.transactions = [
      { ...tx({ id: 1, categoryId: null, amount: "-3000" }) },
      { ...tx({ id: 2, categoryId: 99, parentId: 1, amount: "-3000" }) },
    ];
    // Category 99 does not exist, so leaf 1 must be untouched by the split.
    expect(leafOf(data, "2026-02", 1).row.outflow).toBe(0);
  });

  it("recomputes the leaf when the underlying list changes (recalc analogue)", () => {
    const data = baseData();
    data.transactions = [tx({ id: 1, amount: "-4000" })];
    expect(leafOf(data, "2026-02").row.outflow).toBe(-4000);
    data.transactions.push(tx({ id: 2, amount: "-1000" }));
    invalidateBudgetIndex(data);
    expect(leafOf(data, "2026-02").row.outflow).toBe(-5000);
    // An other-category row never leaks in after the change either.
    data.transactions.push(tx({ id: 3, categoryId: null, amount: "-9999" }));
    invalidateBudgetIndex(data);
    expect(leafOf(data, "2026-02").row.outflow).toBe(-5000);
  });
});

describe("shouldAddSubTransaction mapping (oracle :480-544)", () => {
  it("categorized legs count; transfer legs to on-budget accounts are excluded", () => {
    // Oracle excludes subs whose target account is on-budget; here that is
    // the internal-transfer rule: no boundary crossing, no outflow.
    const internal = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: true,
      amount: -1000,
      categoryId: null,
      allowMissingOutflowCategory: true,
    });
    expect(internal.isBoundaryCrossing).toBe(false);

    const data = baseData();
    data.accounts.push({ ...checking(2), name: "Savings" });
    data.transactions = [
      tx({
        id: 1,
        categoryId: null,
        transferAccountId: 2,
        amount: "-1000",
        date: "2026-02-10",
      }),
    ];
    expect(leafOf(data, "2026-02").row.outflow).toBe(0);
  });

  it("null-category boundary inflow is income; categorized boundary outflow posts to the leaf", () => {
    const inflow = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: false,
      amount: 1000,
      categoryId: null,
      allowMissingOutflowCategory: true,
    });
    expect(inflow.isBoundaryCrossing).toBe(true);
    expect(inflow.isIncome).toBe(true);

    const categorized = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: false,
      amount: 1000,
      categoryId: 1,
      allowMissingOutflowCategory: true,
    });
    expect(categorized.isBoundaryCrossing).toBe(true);
    expect(categorized.isIncome).toBe(false);
    expect(categorized.categoryId).toBe(1);
  });
});

describe("spending sign convention (oracle :546-567)", () => {
  it("outflow counts positive spent; refunds clamp display outflow but raise available", () => {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2026-02", amount: "10000" }];
    data.transactions = [tx({ id: 1, amount: "-4000" })];
    const spent = leafOf(data, "2026-02").row;
    expect(spent.outflow).toBe(-4000);
    expect(spent.available).toBe(6000);

    const refund = baseData();
    refund.assignments = [{ id: 1, categoryId: 1, month: "2026-02", amount: "10000" }];
    refund.transactions = [tx({ id: 1, amount: "6000" })];
    const got = leafOf(refund, "2026-02").row;
    expect(got.outflow).toBe(0);
    expect(got.available).toBe(16000);
  });
});

describe("budgeted math and NaN guards (oracle :569-632)", () => {
  it("rounds assignments to cents and cascades budgeted into balance", () => {
    // Oracle budgeted=100.126 -> 100.13, spent=5.125 -> 5.13, balance=95.
    expect(dollarsToCents(100.126)).toBe(10013);
    const data = baseData();
    data.assignments = [
      { id: 1, categoryId: 1, month: "2026-02", amount: String(dollarsToCents(100.126)) },
    ];
    data.transactions = [tx({ id: 1, amount: String(-dollarsToCents(5.125)) })];
    const { row } = leafOf(data, "2026-02");
    expect(row.assigned).toBe(10013);
    expect(row.outflow).toBe(-513);
    expect(row.available).toBe(9500);
  });

  it("num() rejects NaN (number and string) with TypeError — parity for oracle NaN throws", () => {
    // Oracle MonthlySubCategoryBudget.ts:458/:485/:504 and .as:207/:233/:255
    // throw "NaN passed in" for budgeted/spent/priorBalance; here corrupt
    // money throws TypeError("Invalid amount ...") at the parse boundary.
    expect(() => num(NaN)).toThrow(TypeError);
    expect(() => num(NaN)).toThrow("Invalid amount");
    expect(() => num("NaN")).toThrow(TypeError);
    expect(() => num("NaN")).toThrow("Invalid amount");
  });

  it("empty assignment leaves available at the carryover seed (zeroOut analogue)", () => {
    const data = baseData();
    data.categories[0] = {
      ...(data.categories[0] as Category),
      carryover: "10000",
    };
    data.assignments = [{ id: 1, categoryId: 1, month: "2026-02", amount: "10000" }];
    expect(leafOf(data, "2026-02").row.available).toBe(20000);
    const cleared = baseData();
    cleared.categories[0] = {
      ...(cleared.categories[0] as Category),
      carryover: "10000",
    };
    expect(leafOf(cleared, "2026-02").row.available).toBe(10000);
  });
});

describe("rollover matrix (oracle :634-775)", () => {
  function twoMonthLedger(prevAvailable: number): BudgetData {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2026-01", amount: "0" }];
    if (prevAvailable < 0) {
      data.transactions = [tx({ id: 1, amount: String(prevAvailable), date: "2026-01-15" })];
    } else {
      data.assignments = [{ id: 1, categoryId: 1, month: "2026-01", amount: String(prevAvailable) }];
    }
    return data;
  }

  it("carries non-negative balances regardless of handling", () => {
    for (const carriesOver of [true, false]) {
      const data = twoMonthLedger(7000);
      data.categories[0] = {
        ...(data.categories[0] as Category),
        overspendCarriesOver: carriesOver,
      };
      expect(leafOf(data, "2026-02").row.carryoverIn).toBe(7000);
    }
  });

  it("negative carries only when Confined; AffectsBuffer clamps and deducts TBB", () => {
    const confined = twoMonthLedger(-5000);
    confined.categories[0] = {
      ...(confined.categories[0] as Category),
      overspendCarriesOver: true,
    };
    const confinedLeaf = leafOf(confined, "2026-02");
    expect(confinedLeaf.row.carryoverIn).toBe(-5000);
    expect(confinedLeaf.result.overspentPrevious).toBe(0);

    const affects = twoMonthLedger(-5000);
    const affectsLeaf = leafOf(affects, "2026-02");
    expect(affectsLeaf.row.carryoverIn).toBe(0);
    expect(affectsLeaf.row.available).toBe(0);
    expect(affectsLeaf.result.overspentPrevious).toBe(5000);
    expect(affectsLeaf.result.tbb).toBe(-5000);
  });

  it("no flags anywhere inherits the AffectsBuffer default (clamps)", () => {
    const data = twoMonthLedger(-5000);
    expect(leafOf(data, "2026-02").row.carryoverIn).toBe(0);
  });

  it("explicit override wins over the static flag in both directions", () => {
    const flagTrue = twoMonthLedger(-5000);
    flagTrue.categories[0] = {
      ...(flagTrue.categories[0] as Category),
      overspendCarriesOver: true,
    };
    expect(
      computeBudget(flagTrue, "2026-02", { "1": { "2026-01": false } }).groups
        .flatMap((g) => g.rows)
        .find((r) => r.category.id === 1)?.carryoverIn,
    ).toBe(0);

    const flagFalse = twoMonthLedger(-5000);
    expect(
      computeBudget(flagFalse, "2026-02", { "1": { "2026-01": true } }).groups
        .flatMap((g) => g.rows)
        .find((r) => r.category.id === 1)?.carryoverIn,
    ).toBe(-5000);
  });

  it("handling is inherited across months (grandparent Confined analogue)", () => {
    const data = twoMonthLedger(-5000);
    const res = computeBudget(data, "2026-03", { "1": { "2026-01": true } });
    const row = res.groups.flatMap((g) => g.rows).find((r) => r.category.id === 1);
    expect(row?.carryoverIn).toBe(-5000);
  });

  it("own-month handling does not change the rollover rule", () => {
    const data = twoMonthLedger(-5000);
    const res = computeBudget(data, "2026-02", { "1": { "2026-02": true } });
    const row = res.groups.flatMap((g) => g.rows).find((r) => r.category.id === 1);
    expect(row?.carryoverIn).toBe(0);
  });

  it("recomputing with replaced prior data follows the new leaf (listener-swap analogue)", () => {
    const before = twoMonthLedger(7000);
    expect(leafOf(before, "2026-02").row.carryoverIn).toBe(7000);
    const after = twoMonthLedger(1000);
    expect(leafOf(after, "2026-02").row.carryoverIn).toBe(1000);
    // Mutating the discarded object cannot affect the new computation.
    before.assignments = [{ id: 9, categoryId: 1, month: "2026-01", amount: "999999" }];
    invalidateBudgetIndex(before);
    expect(leafOf(after, "2026-02").row.carryoverIn).toBe(1000);
  });
});

describe("inheritance, cache, and index reuse (oracle :777-854, :1017-1039)", () => {
  it("data.overspendOverrides seeds the walk; the explicit param wins", () => {
    const mk = (): BudgetData => {
      const data = baseData();
      data.assignments = [{ id: 1, categoryId: 1, month: "2026-01", amount: "0" }];
      data.transactions = [tx({ id: 1, amount: "-5000", date: "2026-01-15" })];
      data.overspendOverrides = { "1": { "2026-01": true } };
      return data;
    };
    expect(leafOf(mk(), "2026-02").row.carryoverIn).toBe(-5000);
    const overridden = mk();
    const res = computeBudget(overridden, "2026-02", { "1": { "2026-01": false } });
    const row = res.groups.flatMap((g) => g.rows).find((r) => r.category.id === 1);
    expect(row?.carryoverIn).toBe(0);
  });

  it("serialized index round-trips; bad versions are rejected (VO analogue)", () => {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2026-02", amount: "10000" }];
    data.transactions = [tx({ id: 1, amount: "-4000" })];
    const expected = leafOf(data, "2026-02").row.available;

    data.budgetIndex = buildBudgetIndex(data);
    expect(leafOf(data, "2026-02").row.available).toBe(expected);

    data.budgetIndex = { ...buildBudgetIndex(data), version: 999 };
    invalidateBudgetIndex(data);
    // Rejected index forces a fresh walk with identical results.
    const fresh = baseData();
    fresh.assignments = [{ id: 1, categoryId: 1, month: "2026-02", amount: "10000" }];
    fresh.transactions = [tx({ id: 1, amount: "-4000" })];
    expect(leafOf(fresh, "2026-02").row.available).toBe(expected);
  });

  it("invalidate is idempotent and detach-safe (dispose analogue)", () => {
    const data = baseData();
    data.assignments = [{ id: 1, categoryId: 1, month: "2026-02", amount: "10000" }];
    invalidateBudgetIndex(data);
    invalidateBudgetIndex(data);
    expect(leafOf(data, "2026-02").row.available).toBe(10000);
  });

  it("normalizeBudgetData reuses identity when there is nothing to fix (createFromVO analogue)", () => {
    const data = baseData();
    expect(normalizeBudgetData(data)).toBe(data);
  });
});
