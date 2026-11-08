/**
 * Property tests for the budget engine (`src/budget-engine.ts`).
 *
 * Strategy:
 * - a small random-but-valid `BudgetData` world generator (`worldArb`),
 * - structural identities (TBB formula, rollups, display bounds),
 * - `computeBudget` vs `buildBudgetIndex` cross-checks,
 * - differentials (fresh vs hydrated index, split stripping, override shapes),
 * - the conservation identity (accounts = categories + TBB),
 * - decision matrices for income classification and normalization.
 *
 * Each property runs over hundreds of generated inputs; a failure shrinks
 * to a minimal counterexample.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BUDGET_INDEX_VERSION,
  buildBudgetIndex,
  computeBudget,
  getMonthsWithData,
  invalidateBudgetIndex,
  isIncomeTransaction,
  normalizeBudgetData,
} from "../../src/budget-engine.js";
import { num } from "../../src/format.js";
import {
  classifyBoundaryTransfer,
  isInternalTransfer,
} from "../../src/transfers.js";
import type {
  Account,
  Assignment,
  BudgetData,
  BudgetResult,
  Category,
  CategoryGroup,
  OverspendOverrides,
  Transaction,
} from "../../src/types.js";
import { accountArb, idArb, tx } from "./arbitraries.js";

/* ---------------- world generator ---------------- */

const WORLD_MONTHS: string[] = ["2026-01", "2026-02", "2026-03"];
const TARGET_MONTHS: string[] = ["2025-12", ...WORLD_MONTHS, "2026-04"];

type AcctSpec = { kind: Account["kind"]; onBudget: boolean; balance: number };
type CatSpec = {
  groupId: number;
  carryover: number;
  goalTarget: string | null;
  // null is a realistic DB value (and fast-check v4's bare option() default).
  overspendCarriesOver: boolean | undefined | null;
};
type AssignSpec = { categoryId: number; month: string; amount: number };
type TxSpec = {
  accountId: number;
  categoryId: number | null;
  date: string;
  amount: number;
  transferAccountId: number | null;
  isIncome: boolean | undefined;
  incomeMonth: string | null;
};

/** Coherent accounts only: liquid±, on-budget credit, off-budget tracking. */
const acctSpecArb: fc.Arbitrary<AcctSpec> = fc
  .tuple(
    fc.constantFrom("liquid", "credit", "offbudget"),
    fc.integer({ min: -200_000, max: 500_000 }),
    fc.boolean(),
  )
  .map(([kind, balance, liquidOn]) => ({
    kind,
    balance,
    onBudget: kind === "liquid" ? liquidOn : kind === "credit",
  }));

function buildWorld(
  accSpecs: AcctSpec[],
  groupIds: number[],
  catSpecs: CatSpec[],
  assignSpecs: AssignSpec[],
  txSpecs: TxSpec[],
  ccSetup: boolean,
): BudgetData {
  const accounts: Account[] = accSpecs.map((s, i) => ({
    id: i + 1,
    name: `Account ${i + 1}`,
    kind: s.kind,
    groupLabel: s.kind === "credit" ? "Credit" : "Cash",
    balance: String(s.balance),
    onBudget: s.onBudget,
    sort: i,
  }));
  const groups: CategoryGroup[] = groupIds.map((id, i) => ({
    id,
    name: `Group ${id}`,
    sort: i,
    isCreditCardPayments: false,
  }));
  const categories: Category[] = catSpecs.map((s, i) => ({
    id: (i + 1) * 100,
    groupId: s.groupId,
    name: `Cat ${(i + 1) * 100}`,
    sort: i,
    carryover: String(s.carryover),
    goalTarget: s.goalTarget,
    linkedAccountId: null,
    ...(s.overspendCarriesOver === undefined
      ? {}
      : { overspendCarriesOver: s.overspendCarriesOver }),
  }));
  if (ccSetup) {
    const ccAccs = accounts.filter((a) => a.kind === "credit" && a.onBudget);
    if (ccAccs.length > 0) {
      groups.push({
        id: 90,
        name: "Credit Card Payments",
        sort: 99,
        isCreditCardPayments: true,
      });
      ccAccs.forEach((a, i) => {
        categories.push({
          id: 900 + a.id,
          groupId: 90,
          name: a.name,
          sort: i,
          carryover: "0",
          goalTarget: null,
          linkedAccountId: a.id,
          overspendCarriesOver: false,
        });
      });
    }
  }
  const assignments: Assignment[] = assignSpecs.map((s, i) => ({
    id: i + 1,
    categoryId: s.categoryId,
    month: s.month,
    amount: String(s.amount),
  }));
  const transactions: Transaction[] = txSpecs.map((s, i) =>
    tx({
      id: i + 1,
      accountId: s.accountId,
      categoryId: s.categoryId,
      date: s.date,
      amount: String(s.amount),
      transferAccountId: s.transferAccountId,
      incomeMonth: s.incomeMonth,
      ...(s.isIncome === undefined ? {} : { isIncome: s.isIncome }),
    }),
  );
  return { accounts, groups, categories, assignments, transactions, recurring: [] };
}

/** Small valid budget worlds with coherent references (no splits, no overrides). */
const worldArb: fc.Arbitrary<{ data: BudgetData; target: string }> = fc
  .tuple(
    fc.integer({ min: 1, max: 3 }),
    fc.integer({ min: 1, max: 2 }),
    fc.integer({ min: 1, max: 4 }),
    fc.integer({ min: 0, max: 4 }),
    fc.integer({ min: 0, max: 8 }),
  )
  .chain(([nAcc, nGroups, nCats, nAssign, nTx]) => {
    const groupIds = Array.from({ length: nGroups }, (_, i) => (i + 1) * 10);
    const catIds = Array.from({ length: nCats }, (_, i) => (i + 1) * 100);
    const catSpecArb: fc.Arbitrary<CatSpec> = fc.record({
      groupId: fc.constantFrom(...groupIds),
      carryover: fc.integer({ min: -50_000, max: 200_000 }),
      goalTarget: fc.oneof(
        fc.constant(null),
        fc.integer({ min: 0, max: 300_000 }).map(String),
      ),
      overspendCarriesOver: fc.option(fc.boolean()),
    });
    const assignSpecArb: fc.Arbitrary<AssignSpec> = fc.record({
      categoryId: fc.constantFrom(...catIds),
      month: fc.constantFrom(...WORLD_MONTHS),
      amount: fc.integer({ min: -200_000, max: 500_000 }),
    });
    return fc
      .tuple(
        fc.array(acctSpecArb, { minLength: nAcc, maxLength: nAcc }),
        fc.array(catSpecArb, { minLength: nCats, maxLength: nCats }),
        fc.array(assignSpecArb, { maxLength: nAssign }),
        fc.constantFrom(...TARGET_MONTHS),
        fc.boolean(),
      )
      .chain(([accSpecs, catSpecs, assignSpecs, target, ccSetup]) => {
        const accIds = accSpecs.map((_, i) => i + 1);
        const sideOf = (id: number): boolean => accSpecs[id - 1]!.onBudget;
        const txSpecArb: fc.Arbitrary<TxSpec> = fc
          .tuple(
            fc.constantFrom(...accIds),
            fc.constantFrom(null, ...catIds),
            fc.constantFrom(...WORLD_MONTHS),
            fc.integer({ min: 1, max: 28 }),
            fc.integer({ min: -300_000, max: 300_000 }),
            // Explicit nil: fast-check v4 defaults bare option() to null,
            // but Transaction.isIncome is boolean|undefined.
            fc.option(fc.boolean(), { nil: undefined }),
            fc.oneof(fc.constant(null), fc.constantFrom(...WORLD_MONTHS)),
            fc.integer({ min: 0, max: 99 }),
          )
          .map(
            ([
              accountId,
              categoryId,
              month,
              day,
              amount,
              isIncome,
              incomeMonth,
              roll,
            ]) => {
              let transferAccountId: number | null = null;
              if (roll >= 80 && accIds.length > 1) {
                const others = accIds.filter((id) => id !== accountId);
                transferAccountId = others[roll % others.length]!;
              }
              // Keep transfers in-contract: same-boundary moves carry no
              // category (see validateTransferEligibility); boundary
              // transfers may carry one.
              const crossing =
                transferAccountId != null &&
                sideOf(accountId) !== sideOf(transferAccountId);
              return {
                accountId,
                categoryId: transferAccountId != null && !crossing ? null : categoryId,
                date: `${month}-${String(day).padStart(2, "0")}`,
                amount,
                transferAccountId,
                isIncome,
                incomeMonth,
              };
            },
          );
        return fc
          .tuple(fc.array(txSpecArb, { maxLength: nTx }))
          .map(([txSpecs]) => ({
            data: buildWorld(
              accSpecs,
              groupIds,
              catSpecs,
              assignSpecs,
              txSpecs,
              ccSetup,
            ),
            target,
          }));
      });
  });

const worldDataArb: fc.Arbitrary<BudgetData> = worldArb.map(({ data }) => data);

/**
 * Worlds in which the conservation oracle is valid:
 *
 * - Cash-only (no on-budget credit accounts). The identity's unmatched-debt
 *   term, max(0, ccDebt - negatives), treats every category negative as CC
 *   coverage — but cash-driven negatives (a clamped cash seed/overspend, a
 *   carried red-arrow balance) are unrelated to card debt, so clamping or
 *   carrying them while debt exists wobbles the difference. With no cards
 *   the term is identically zero and the identity is exact.
 * - Fully attributed: every on-budget flow is categorized or income.
 *   Uncategorized non-income amounts leave no budget trace (the register
 *   shows them; the budget cannot), so they are given the first regular
 *   category. Internal transfers net to zero and need nothing.
 *
 * CC conservation stays covered by the fixture-based integrity tests;
 * overpayment (card credit balances) is a known further gap in the
 * identity, observed via a probe: an unfunded payment of X breaks the
 * difference by exactly X.
 */
const conservationWorldArb = worldArb
  .filter(
    ({ data }) =>
      !data.accounts.some((a) => a.kind === "credit" && a.onBudget),
  )
  .map(({ data, target }) => {
    const accountMap = new Map(data.accounts.map((a) => [a.id, a]));
    const firstCatId = data.categories[0]!.id; // worldArb leads with regular categories
    const transactions = data.transactions.map((t) => {
      if (t.categoryId != null || t.parentId != null) return t;
      if (num(t.amount) === 0) return t;
      const onA = accountMap.get(t.accountId)?.onBudget ?? true;
      const helperMoves =
        t.transferAccountId != null
          ? onA || (accountMap.get(t.transferAccountId)?.onBudget ?? true)
          : onA;
      if (!helperMoves) return t;
      if (isInternalTransfer(t, accountMap)) return t;
      if (isIncomeTransaction(t, accountMap)) return t;
      return { ...t, categoryId: firstCatId };
    });
    return { target, data: { ...data, transactions } };
  });

/* ---------------- conservation oracle ---------------- */

/**
 * Conservation identity, mirroring the `checkBudgetIntegrity` oracle in
 * `../budget-engine.test.ts`: every cent in on-budget accounts is either
 * assigned to a category or sitting in TBB (plus unmatched CC debt).
 */
/**
 * Replay on-budget account balances up to and including `month`, mirroring
 * the `checkBudgetIntegrity` oracle in `../budget-engine.test.ts`.
 */
function replayBalances(
  data: BudgetData,
  month: string,
): Map<number, number> {
  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));
  const splitParentIds = new Set<number>();
  for (const t of data.transactions) {
    if (t.parentId != null) splitParentIds.add(t.parentId);
  }

  const onBudgetAccounts = data.accounts.filter((a) => a.onBudget);
  const accountBalances = new Map<number, number>();
  for (const a of onBudgetAccounts) {
    accountBalances.set(a.id, Number(a.balance ?? 0));
  }

  for (const t of data.transactions) {
    if (splitParentIds.has(t.id)) continue;
    const accA = accountMap.get(t.accountId);
    const onA = accA ? accA.onBudget : true;
    const isIncome = isIncomeTransaction(t, accountMap);
    const effectiveMonth = isIncome
      ? t.incomeMonth || t.date.slice(0, 7)
      : t.date.slice(0, 7);
    if (effectiveMonth > month) continue;
    const amt = Number(t.amount);
    if (t.transferAccountId != null) {
      const accB = accountMap.get(t.transferAccountId);
      const onB = accB ? accB.onBudget : true;
      if (onA)
        accountBalances.set(
          t.accountId,
          (accountBalances.get(t.accountId) ?? 0) + amt,
        );
      if (onB)
        accountBalances.set(
          t.transferAccountId,
          (accountBalances.get(t.transferAccountId) ?? 0) - amt,
        );
    } else if (onA) {
      accountBalances.set(
        t.accountId,
        (accountBalances.get(t.accountId) ?? 0) + amt,
      );
    }
  }

  return accountBalances;
}

function budgetDifference(data: BudgetData, month: string): number {
  const result = computeBudget(data, month);
  const accountBalances = replayBalances(data, month);

  const onBudgetAccounts = data.accounts.filter((a) => a.onBudget);
  const totalAccountBalance = Array.from(accountBalances.values()).reduce(
    (s, v) => s + v,
    0,
  );
  const totalCategoryAvailable = result.groups.reduce((s, g) => s + g.available, 0);
  const ccAccounts = onBudgetAccounts.filter((a) => a.kind === "credit");
  const totalCCDebt = ccAccounts.reduce(
    (s, a) => s + Math.max(0, -(accountBalances.get(a.id) ?? 0)),
    0,
  );
  const negativeCategorySum = result.groups.reduce(
    (s, g) => s + Math.max(0, -g.available),
    0,
  );
  const unmatchedCCDebt = Math.max(0, totalCCDebt - negativeCategorySum);
  return Math.round(
    totalAccountBalance + unmatchedCCDebt - totalCategoryAvailable - result.tbb,
  );
}

/**
 * A world's initial imbalance: starting on-budget balances minus starting
 * category seeds. (The full formula adds unmatched starting card debt, but
 * conservation worlds hold no on-budget credit — see below — so that term
 * is always zero here.)
 */
function initialImbalance(data: BudgetData): number {
  const balances = data.accounts
    .filter((a) => a.onBudget)
    .reduce((s, a) => s + Number(a.balance ?? 0), 0);
  const seeds = normalizeBudgetData(data).categories.reduce(
    (s, c) => s + num(c.carryover),
    0,
  );
  return Math.round(balances - seeds);
}

/* ---------------- computeBudget structural ---------------- */

describe("computeBudget structural properties", () => {
  it("satisfies the TBB identity, rollups, and sort order", () => {
    fc.assert(
      fc.property(worldArb, ({ data, target }) => {
        const r = computeBudget(data, target);
        expect(r.tbb).toBe(
          Math.round(r.totalIncome - r.totalAssigned + r.priorSurplus),
        );
        expect(r.overBudgeted).toBe(r.tbb < 0);
        expect(r.totalAssigned).toBe(
          Math.round(r.groups.reduce((s, g) => s + g.assigned, 0)),
        );
        for (const g of r.groups) {
          expect(g.assigned).toBe(
            Math.round(g.rows.reduce((s, row) => s + row.assigned, 0)),
          );
          expect(g.outflow).toBe(
            Math.round(g.rows.reduce((s, row) => s + row.outflow, 0)),
          );
          expect(g.available).toBe(
            Math.round(g.rows.reduce((s, row) => s + row.available, 0)),
          );
        }
        const groupSorts = r.groups.map((g) => g.group.sort);
        expect([...groupSorts].sort((a, b) => a - b)).toEqual(groupSorts);
        for (const g of r.groups) {
          const catSorts = g.rows.map((row) => row.category.sort);
          expect([...catSorts].sort((a, b) => a - b)).toEqual(catSorts);
        }
      }),
    );
  });

  it("keeps every row within display bounds", () => {
    fc.assert(
      fc.property(worldArb, ({ data, target }) => {
        const norm = normalizeBudgetData(data);
        const ccGroupIds = new Set(
          norm.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id),
        );
        const r = computeBudget(data, target);
        for (const g of r.groups) {
          for (const row of g.rows) {
            expect(row.outflow).toBeLessThanOrEqual(0);
            expect(row.fundedPct).toBeGreaterThanOrEqual(0);
            expect(row.fundedPct).toBeLessThanOrEqual(1);
            for (const v of [
              row.carryoverIn,
              row.assigned,
              row.outflow,
              row.available,
              row.ccBuffer,
            ]) {
              expect(Number.isFinite(v)).toBe(true);
            }
            if (
              !(
                ccGroupIds.has(row.category.groupId) &&
                row.category.linkedAccountId != null
              )
            ) {
              expect(row.ccBuffer).toBe(0);
            }
          }
        }
      }),
    );
  });
});

/* ---------------- computeBudget/index agreement ---------------- */

describe("computeBudget/index agreement", () => {
  it("matches buildBudgetIndex row-by-row", () => {
    fc.assert(
      fc.property(worldArb, ({ data, target }) => {
        const idx = buildBudgetIndex(data);
        expect(idx.version).toBe(BUDGET_INDEX_VERSION);
        const months = getMonthsWithData(data);
        const priors = months.filter((m) => m < target);
        const mostRecent =
          priors.length > 0 ? priors[priors.length - 1]! : undefined;
        const r = computeBudget(data, target);
        const norm = normalizeBudgetData(data);
        const ccGroupIds = new Set(
          norm.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id),
        );
        // First linked category per account wins the CC buffer (mirrors computeBudget).
        const payCatToAccount = new Map<number, number>();
        const seen = new Set<number>();
        for (const c of norm.categories) {
          if (
            ccGroupIds.has(c.groupId) &&
            c.linkedAccountId != null &&
            !seen.has(c.linkedAccountId)
          ) {
            seen.add(c.linkedAccountId);
            payCatToAccount.set(c.id, c.linkedAccountId);
          }
        }
        const assigned = idx.assignedByMonth[target] ?? {};
        const rawOut = idx.outflowByMonth[target] ?? {};
        const paydown = idx.unfundedPaydownByMonth?.[target] ?? {};
        const spend = idx.spendByAccountMonth[target] ?? {};
        for (const g of r.groups) {
          for (const row of g.rows) {
            const id = row.category.id;
            const rawFlow = rawOut[id] ?? 0;
            expect(row.assigned).toBe(assigned[id] ?? 0);
            expect(row.outflow).toBe(Math.min(0, rawFlow));
            const linked = payCatToAccount.get(id);
            expect(row.ccBuffer).toBe(linked == null ? 0 : (spend[linked] ?? 0));
            const expectedCarryover = months.includes(target)
              ? (idx.carryoverByMonth[target]?.[id] ?? 0)
              : mostRecent != null
                ? (idx.endingBalanceByMonth?.[mostRecent]?.[id] ?? 0)
                : num(row.category.carryover);
            expect(row.carryoverIn).toBe(expectedCarryover);
            const expectedAvailable = ccGroupIds.has(row.category.groupId)
              ? Math.round(row.carryoverIn + row.assigned + rawFlow + row.ccBuffer)
              : Math.round(
                  row.carryoverIn + row.assigned + rawFlow - (paydown[id] ?? 0),
                );
            expect(row.available).toBe(expectedAvailable);
          }
        }
        expect(r.totalIncome).toBe(idx.incomeByMonth[target] ?? 0);
        expect(r.totalAssigned).toBe(idx.assignedTotalByMonth[target] ?? 0);
        expect(r.overspentPrevious).toBe(
          mostRecent != null ? (idx.overspentByMonth[mostRecent] ?? 0) : 0,
        );
        expect(r.overspentPreviousMonthKey).toBe(mostRecent);
        if (months.includes(target)) {
          expect(r.priorSurplus).toBe(idx.surplusByMonth[target] ?? 0);
        }
        expect(r.incomeFromFuture).toBe(
          idx.incomeFromFutureByMonth?.[target] ?? 0,
        );
        expect(r.incomeFromPast).toBe(idx.incomeFromPastByMonth?.[target] ?? 0);
        expect(r.incomeDeferredToFuture).toBe(
          idx.incomeDeferredToFutureByMonth?.[target] ?? 0,
        );
        expect(r.incomeDeferredToPast).toBe(
          idx.incomeDeferredToPastByMonth?.[target] ?? 0,
        );
      }),
    );
  });
});

/* ---------------- caching ---------------- */

describe("computeBudget caching properties", () => {
  it("is deterministic across repeated calls (cache consistency)", () => {
    fc.assert(
      fc.property(worldArb, ({ data, target }) => {
        expect(computeBudget(data, target)).toEqual(computeBudget(data, target));
        expect(buildBudgetIndex(data)).toEqual(buildBudgetIndex(data));
      }),
    );
  });

  it("agrees between fresh computation and serialized-index hydration", () => {
    fc.assert(
      fc.property(worldArb, ({ data, target }) => {
        const fresh = computeBudget(data, target);
        const viaIndex = computeBudget(
          { ...data, budgetIndex: buildBudgetIndex(data) },
          target,
        );
        expect(viaIndex).toEqual(fresh);
      }),
    );
  });

  it("is unaffected by index invalidation", () => {
    fc.assert(
      fc.property(worldArb, ({ data, target }) => {
        const before = computeBudget(data, target);
        invalidateBudgetIndex(data);
        expect(computeBudget(data, target)).toEqual(before);
      }),
    );
  });
});

/* ---------------- conservation ---------------- */

describe("budget conservation", () => {
  it("preserves the initial imbalance exactly", () => {
    fc.assert(
      fc.property(conservationWorldArb, ({ data, target }) => {
        expect(budgetDifference(data, target)).toBe(initialImbalance(data));
      }),
      // The cash-only filter discards credit worlds; run extra cases.
      { numRuns: 300 },
    );
  });
});

/* ---------------- splits ---------------- */

type SplitKid = {
  accountId: number;
  categoryId: number;
  month: string;
  day: number;
  amount: number;
};

const withSplitFamiliesArb = (
  base: fc.Arbitrary<{ data: BudgetData; target: string }>,
): fc.Arbitrary<{
  data: BudgetData;
  target: string;
  families: SplitKid[][];
}> =>
  base.chain(({ data, target }) => {
    const accIds = data.accounts.map((a) => a.id);
    const catIds = data.categories.map((c) => c.id).filter((id) => id < 900);
    const childArb: fc.Arbitrary<SplitKid> = fc.record({
      accountId: fc.constantFrom(...accIds),
      categoryId: fc.constantFrom(...catIds),
      month: fc.constantFrom(...WORLD_MONTHS),
      day: fc.integer({ min: 1, max: 28 }),
      amount: fc
        .tuple(fc.integer({ min: 100, max: 50_000 }), fc.boolean())
        .map(([m, neg]) => (neg ? -m : m)),
    });
    return fc
      .array(fc.array(childArb, { minLength: 2, maxLength: 3 }), {
        maxLength: 2,
      })
      .map((families) => ({ data, target, families }));
  });

function attachSplitFamilies(
  data: BudgetData,
  families: SplitKid[][],
): { withParents: BudgetData; stripped: BudgetData } {
  let nextId = Math.max(0, ...data.transactions.map((t) => t.id)) + 1;
  const extra: Transaction[] = [];
  const parentIds: number[] = [];
  for (const kids of families) {
    const parentId = nextId++;
    parentIds.push(parentId);
    const children = kids.map((k) => {
      const row = tx({
        id: nextId++,
        accountId: k.accountId,
        categoryId: k.categoryId,
        date: `${k.month}-${String(k.day).padStart(2, "0")}`,
        amount: String(k.amount),
        parentId,
      });
      extra.push(row);
      return row;
    });
    const sum = children.reduce((s, c) => s + num(c.amount), 0);
    // Scrambled parent total proves the amount is purely informational.
    extra.push(
      tx({
        id: parentId,
        accountId: children[0]!.accountId,
        categoryId: null,
        date: children[0]!.date, // same month: no new month keys
        amount: String(sum + 999),
      }),
    );
  }
  const withParents: BudgetData = {
    ...data,
    transactions: [...data.transactions, ...extra],
  };
  return {
    withParents,
    stripped: {
      ...data,
      transactions: withParents.transactions.filter(
        (t) => !parentIds.includes(t.id),
      ),
    },
  };
}

describe("split handling", () => {
  it("ignores split parent rows entirely", () => {
    fc.assert(
      fc.property(
        withSplitFamiliesArb(worldArb),
        ({ data, target, families }) => {
          const { withParents, stripped } = attachSplitFamilies(data, families);
          expect(getMonthsWithData(withParents)).toEqual(
            getMonthsWithData(stripped),
          );
          expect(computeBudget(withParents, target)).toEqual(
            computeBudget(stripped, target),
          );
        },
      ),
    );
  });

  it("conserves money with splits present", () => {
    fc.assert(
      fc.property(
        withSplitFamiliesArb(conservationWorldArb),
        ({ data, target, families }) => {
          const { withParents } = attachSplitFamilies(data, families);
          expect(budgetDifference(withParents, target)).toBe(
            initialImbalance(withParents),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

/* ---------------- hostile months ---------------- */

const hostileWorldArb: fc.Arbitrary<{ data: BudgetData; target: string }> =
  worldArb.chain(({ data }) =>
    fc
      .tuple(
        fc.array(fc.string({ maxLength: 12 }), {
          minLength: data.assignments.length,
          maxLength: data.assignments.length,
        }),
        fc.array(fc.string({ maxLength: 20 }), {
          minLength: data.transactions.length,
          maxLength: data.transactions.length,
        }),
        fc.array(
          fc.oneof(fc.constant(null), fc.string({ maxLength: 12 })),
          {
            minLength: data.transactions.length,
            maxLength: data.transactions.length,
          },
        ),
        fc.oneof(
          fc.constantFrom(...TARGET_MONTHS),
          fc.string({ maxLength: 12 }),
        ),
      )
      .map(([assignMonths, dates, incomeMonths, target]) => ({
        target,
        data: {
          ...data,
          assignments: data.assignments.map((a, i) => ({
            ...a,
            month: assignMonths[i]!,
          })),
          transactions: data.transactions.map((t, i) => ({
            ...t,
            date: dates[i]!,
            incomeMonth: incomeMonths[i]!,
          })),
        },
      })),
  );

describe("hostile month keys", () => {
  it("never throws on arbitrary month/date strings", () => {
    fc.assert(
      fc.property(hostileWorldArb, ({ data, target }) => {
        let r: BudgetResult | undefined;
        expect(() => {
          r = computeBudget(data, target);
        }).not.toThrow();
        const result = r!;
        expect(Number.isFinite(result.tbb)).toBe(true);
        expect(Number.isFinite(result.totalIncome)).toBe(true);
        expect(Number.isFinite(result.priorSurplus)).toBe(true);
        expect(Number.isFinite(result.totalAssigned)).toBe(true);
        expect(result.tbb).toBe(
          Math.round(
            result.totalIncome - result.totalAssigned + result.priorSurplus,
          ),
        );
        for (const g of result.groups) {
          for (const row of g.rows) {
            expect(row.outflow).toBeLessThanOrEqual(0);
            expect(row.fundedPct).toBeGreaterThanOrEqual(0);
            expect(row.fundedPct).toBeLessThanOrEqual(1);
          }
        }
      }),
    );
  });
});

/* ---------------- income classification ---------------- */

describe("isIncomeTransaction properties", () => {
  type MapShape = "map" | "array" | "undefined";
  const shapeArb: fc.Arbitrary<MapShape> = fc.constantFrom(
    "map",
    "array",
    "undefined",
  );
  const asMap = (
    accs: Account[],
    shape: MapShape,
  ): Map<number, Account> | Account[] | undefined =>
    shape === "undefined"
      ? undefined
      : shape === "map"
        ? new Map(accs.map((a) => [a.id, a] as const))
        : accs;

  const mkAccount = (
    id: number,
    kind: Account["kind"],
    onBudget: boolean,
  ): Account => ({
    id,
    name: `a${id}`,
    kind,
    groupLabel: "g",
    balance: "0",
    onBudget,
    sort: 0,
  });

  it("is always false for categorized rows", () => {
    fc.assert(
      fc.property(
        idArb,
        fc.integer({ min: -100_000, max: 100_000 }).map(String),
        fc.option(fc.boolean(), { nil: undefined }),
        fc.oneof(fc.constant(null), idArb),
        fc.array(accountArb, { maxLength: 2 }),
        shapeArb,
        (categoryId, amount, flag, leg, accs, shape) => {
          const t = tx({
            accountId: 1,
            categoryId,
            amount,
            transferAccountId: leg,
            ...(flag === undefined ? {} : { isIncome: flag }),
          });
          expect(isIncomeTransaction(t, asMap(accs, shape))).toBe(false);
        },
      ),
    );
  });

  it("lets an explicit flag win for regular rows (map path)", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 1, max: 500_000 }),
        (flag, amount) => {
          const acc = mkAccount(1, "liquid", true);
          const t = tx({
            accountId: 1,
            categoryId: null,
            amount: String(amount),
            isIncome: flag,
          });
          expect(isIncomeTransaction(t, [acc])).toBe(flag);
          expect(isIncomeTransaction(t, new Map([[1, acc]]))).toBe(flag);
        },
      ),
    );
  });

  it("classifies unflagged regular rows by side, kind, and sign", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("liquid", "credit", "offbudget"),
        fc.boolean(),
        fc.integer({ min: -100_000, max: 100_000 }),
        (kind, onBudget, amount) => {
          const t = tx({
            accountId: 1,
            categoryId: null,
            amount: String(amount),
          });
          expect(isIncomeTransaction(t, [mkAccount(1, kind, onBudget)])).toBe(
            onBudget && amount > 0 && kind !== "credit",
          );
        },
      ),
    );
  });

  it("agrees with classifyBoundaryTransfer for transfers (map path)", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.oneof(fc.constant(null), fc.string({ maxLength: 7 })),
        fc.option(fc.boolean(), { nil: undefined }),
        fc.constantFrom("map", "array", "missingMap", "missingArray"),
        (onA, onB, amount, incomeMonth, flag, shape) => {
          const missing = shape === "missingMap" || shape === "missingArray";
          const sides: [boolean, boolean] = missing ? [true, true] : [onA, onB];
          const accs = missing
            ? [mkAccount(999, "liquid", false)]
            : [mkAccount(1, "liquid", onA), mkAccount(2, "liquid", onB)];
          const u =
            shape === "map" || shape === "missingMap"
              ? new Map(accs.map((a) => [a.id, a] as const))
              : accs;
          const t = tx({
            accountId: 1,
            transferAccountId: 2,
            categoryId: null,
            amount: String(amount),
            incomeMonth,
            ...(flag === undefined ? {} : { isIncome: flag }),
          });
          const expected = classifyBoundaryTransfer({
            srcOnBudget: sides[0],
            destOnBudget: sides[1],
            amount: num(t.amount),
            categoryId: null,
            incomeMonth,
            allowMissingOutflowCategory: true,
          }).isIncome;
          expect(isIncomeTransaction(t, u)).toBe(expected);
        },
      ),
    );
  });

  it("pins the no-map fallback exactly", () => {
    fc.assert(
      fc.property(
        fc.option(idArb, { nil: null }),
        fc.option(idArb, { nil: null }),
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.option(fc.boolean(), { nil: undefined }),
        (categoryId, transferAccountId, amount, flag) => {
          const t = tx({
            accountId: 1,
            categoryId,
            transferAccountId,
            amount: String(amount),
            ...(flag === undefined ? {} : { isIncome: flag }),
          });
          const expected =
            categoryId != null
              ? false
              : flag !== undefined
                ? flag
                : transferAccountId != null
                  ? false
                  : amount > 0;
          expect(isIncomeTransaction(t)).toBe(expected);
          expect(isIncomeTransaction(t, undefined)).toBe(expected);
        },
      ),
    );
  });
});

/* ---------------- months ---------------- */

describe("getMonthsWithData properties", () => {
  it("returns the sorted unique month keys", () => {
    fc.assert(
      fc.property(hostileWorldArb, ({ data }) => {
        const expected = new Set<string>();
        for (const a of data.assignments) expected.add(a.month);
        for (const t of data.transactions) {
          expected.add(t.date.slice(0, 7));
          if (t.incomeMonth) expected.add(t.incomeMonth);
        }
        expect(getMonthsWithData(data)).toEqual([...expected].sort());
      }),
    );
  });
});

/* ---------------- normalization ---------------- */

const messyDataArb: fc.Arbitrary<BudgetData> = worldArb.chain(({ data }) =>
  fc.tuple(fc.boolean(), fc.boolean()).map(([dup, invalid]) => {
    const accounts = [...data.accounts];
    if (!accounts.some((a) => a.kind === "credit" && a.onBudget)) {
      accounts.push({
        id: 50,
        name: "Card",
        kind: "credit",
        groupLabel: "Credit",
        balance: "0",
        onBudget: true,
        sort: 50,
      });
    }
    const ccAcc = accounts.find((a) => a.kind === "credit" && a.onBudget)!;
    const groups: CategoryGroup[] = [
      ...data.groups,
      { id: 91, name: "CCP", sort: 98, isCreditCardPayments: true },
    ];
    const categories: Category[] = [...data.categories];
    categories.push({
      id: 951,
      groupId: 91,
      name: "Pay",
      sort: 0,
      carryover: "0",
      goalTarget: null,
      linkedAccountId: ccAcc.id,
    });
    if (dup) {
      categories.push({
        id: 952,
        groupId: 91,
        name: "Pay dup",
        sort: 1,
        carryover: "5",
        goalTarget: null,
        linkedAccountId: ccAcc.id,
      });
    }
    if (invalid) {
      categories.push({
        id: 953,
        groupId: data.groups[0]!.id,
        name: "Bad link",
        sort: 99,
        carryover: "0",
        goalTarget: null,
        linkedAccountId: ccAcc.id,
      });
    }
    return { ...data, accounts, groups, categories };
  }),
);

describe("normalizeBudgetData properties", () => {
  const anyDataArb = fc.oneof(worldDataArb, messyDataArb);

  it("is a fixpoint", () => {
    fc.assert(
      fc.property(anyDataArb, (data) => {
        const once = normalizeBudgetData(data);
        expect(normalizeBudgetData(once)).toBe(once);
      }),
    );
  });

  it("establishes exactly one valid pay category per on-budget credit account", () => {
    fc.assert(
      fc.property(anyDataArb, (data) => {
        const norm = normalizeBudgetData(data);
        const ccGroupIds = new Set(
          norm.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id),
        );
        const linksByAccount = new Map<number, number[]>();
        for (const c of norm.categories) {
          if (c.linkedAccountId != null) {
            expect(ccGroupIds.has(c.groupId)).toBe(true);
            const list = linksByAccount.get(c.linkedAccountId) ?? [];
            list.push(c.id);
            linksByAccount.set(c.linkedAccountId, list);
          }
        }
        for (const [, ids] of linksByAccount) {
          expect(ids.length).toBe(1);
        }
        for (const a of norm.accounts) {
          if (a.kind === "credit" && a.onBudget !== false) {
            expect(linksByAccount.get(a.id)?.length).toBe(1);
          }
        }
        // First valid occurrence in the input keeps the link; otherwise the
        // keeper is synthesized (synthetic ids are negative).
        const inputCcGroups = new Set(
          data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id),
        );
        for (const [accId, keptIds] of linksByAccount) {
          const firstValid = data.categories.find(
            (c) =>
              c.linkedAccountId === accId && inputCcGroups.has(c.groupId),
          );
          if (firstValid) {
            expect(keptIds).toEqual([firstValid.id]);
          } else {
            expect(keptIds.length).toBe(1);
            expect(keptIds[0]!).toBeLessThan(0);
          }
        }
      }),
    );
  });

  it("never mutates its input", () => {
    fc.assert(
      fc.property(anyDataArb, (data) => {
        const before = JSON.stringify(data);
        normalizeBudgetData(data);
        expect(JSON.stringify(data)).toBe(before);
      }),
    );
  });

  it("returns malformed input unchanged", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant({}),
          fc.record({ accounts: fc.constant([]) }),
          fc.record({ accounts: fc.constant([]), groups: fc.constant([]) }),
        ),
        (bad) => {
          expect(normalizeBudgetData(bad as unknown as BudgetData)).toBe(
            bad as unknown as BudgetData,
          );
        },
      ),
    );
  });
});

/* ---------------- overrides ---------------- */

describe("overspend override properties", () => {
  it("treats empty-ish overrides exactly like absent ones", () => {
    const emptyishArb = fc.oneof(
      fc.constant({}),
      fc.constant(null),
      fc.constant(undefined),
      fc.constant({ "999": {} }),
      fc.constant({ abc: { "2026-01": true } }),
      fc.constant({ "1": { "2026-01": "yes" } }),
    );
    fc.assert(
      fc.property(worldArb, emptyishArb, ({ data, target }, o) => {
        expect(
          computeBudget(data, target, o as unknown as OverspendOverrides),
        ).toEqual(computeBudget(data, target));
      }),
    );
  });

  it("treats Record, Map, and mixed override shapes identically", () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.array(
          fc.tuple(
            fc.integer({ min: 1, max: 500 }),
            fc.constantFrom(...WORLD_MONTHS),
            fc.boolean(),
          ),
          { minLength: 1, maxLength: 3 },
        ),
        ({ data, target }, entries) => {
          const record: OverspendOverrides = {};
          const map = new Map<number, Map<string, boolean>>();
          const mixed = new Map<string | number, Record<string, boolean>>();
          for (const [cat, month, value] of entries) {
            const key = String(cat);
            if (!record[key]) record[key] = {};
            record[key]![month] = value;
            let inner = map.get(cat);
            if (!inner) {
              inner = new Map();
              map.set(cat, inner);
            }
            inner.set(month, value);
            let rec = mixed.get(cat);
            if (!rec) {
              rec = {};
              mixed.set(cat, rec);
            }
            rec[month] = value;
          }
          const fromRecord = computeBudget(data, target, record);
          expect(computeBudget(data, target, map)).toEqual(fromRecord);
          expect(computeBudget(data, target, mixed)).toEqual(fromRecord);
        },
      ),
    );
  });

  it("ignores overrides in months after the target", () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.array(
          fc.tuple(
            fc.integer({ min: 1, max: 500 }),
            fc.constantFrom("2026-02", "2026-03"),
            fc.boolean(),
          ),
          { minLength: 1, maxLength: 3 },
        ),
        ({ data }, entries) => {
          const anchored: BudgetData = {
            ...data,
            transactions: [
              ...data.transactions,
              tx({
                id: 10001,
                accountId: data.accounts[0]!.id,
                date: "2026-01-05",
                amount: "100",
              }),
              tx({
                id: 10002,
                accountId: data.accounts[0]!.id,
                date: "2026-02-05",
                amount: "100",
              }),
            ],
          };
          const overrides: OverspendOverrides = {};
          for (const [cat, month, value] of entries) {
            const key = String(cat);
            if (!overrides[key]) overrides[key] = {};
            overrides[key]![month] = value;
          }
          expect(computeBudget(anchored, "2026-01", overrides)).toEqual(
            computeBudget(anchored, "2026-01"),
          );
        },
      ),
    );
  });
});

/* ---------------- behavioral pins ---------------- */

const checkingWorld = (extra: Partial<BudgetData>): BudgetData => ({
  accounts: [
    {
      id: 1,
      name: "Checking",
      kind: "liquid",
      groupLabel: "Cash",
      balance: "0",
      onBudget: true,
      sort: 0,
    },
  ],
  groups: [{ id: 10, name: "Group", sort: 0, isCreditCardPayments: false }],
  categories: [
    {
      id: 100,
      groupId: 10,
      name: "Cat",
      sort: 0,
      carryover: "0",
      goalTarget: null,
      linkedAccountId: null,
    },
  ],
  assignments: [],
  transactions: [],
  recurring: [],
  ...extra,
});

describe("cash overspending behavior", () => {
  it("clamps or carries negative balances per the effective handling", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.boolean(),
        fc.oneof(fc.constant(undefined), fc.boolean()),
        (assigned, deficit, staticFlag, override) => {
          const data = checkingWorld({
            categories: [
              {
                id: 100,
                groupId: 10,
                name: "Cat",
                sort: 0,
                carryover: "0",
                goalTarget: null,
                linkedAccountId: null,
                overspendCarriesOver: staticFlag,
              },
            ],
            assignments: [
              {
                id: 1,
                categoryId: 100,
                month: "2026-01",
                amount: String(assigned),
              },
            ],
            transactions: [
              tx({
                id: 1,
                accountId: 1,
                categoryId: 100,
                date: "2026-01-15",
                amount: String(-(assigned + deficit)),
              }),
            ],
          });
          const overrides: OverspendOverrides | undefined =
            override === undefined
              ? undefined
              : { "100": { "2026-01": override } };
          const carries = override ?? staticFlag;
          const jan = computeBudget(data, "2026-01", overrides);
          const feb = computeBudget(data, "2026-02", overrides);
          const janRow = jan.groups[0]!.rows[0]!;
          const febRow = feb.groups[0]!.rows[0]!;
          expect(janRow.available).toBe(-deficit);
          expect(jan.overspentPrevious).toBe(0);
          if (carries) {
            expect(febRow.carryoverIn).toBe(-deficit);
            expect(feb.overspentPrevious).toBe(0);
          } else {
            expect(febRow.carryoverIn).toBe(0);
            expect(feb.overspentPrevious).toBe(deficit);
            expect(feb.overspentPreviousMonthKey).toBe("2026-01");
          }
        },
      ),
    );
  });
});

describe("income deferral behavior", () => {
  it("attributes income to incomeMonth with lineage breakdowns", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200_000 }),
        fc.boolean(),
        (income, forward) => {
          const date = forward ? "2026-01-15" : "2026-02-15";
          const budgetMonth = forward ? "2026-02" : "2026-01";
          const data = checkingWorld({
            transactions: [
              tx({
                id: 1,
                accountId: 1,
                categoryId: null,
                date,
                amount: String(income),
                incomeMonth: budgetMonth,
              }),
            ],
          });
          const atBudget = computeBudget(data, budgetMonth);
          const atDate = computeBudget(data, forward ? "2026-01" : "2026-02");
          expect(atBudget.totalIncome).toBe(income);
          expect(atDate.totalIncome).toBe(0);
          if (forward) {
            expect(atBudget.incomeFromPast).toBe(income);
            expect(atDate.incomeDeferredToFuture).toBe(income);
          } else {
            expect(atBudget.incomeFromFuture).toBe(income);
            expect(atDate.incomeDeferredToPast).toBe(income);
          }
        },
      ),
    );
  });
});
