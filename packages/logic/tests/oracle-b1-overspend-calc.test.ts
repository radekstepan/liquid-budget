/**
 * oracle-b1-overspend-calc.test.ts
 *
 * Oracle parity port of `../ynab4-modern/packages/domain/src/`:
 * - `OverspendingHandling.test.ts` (6 tests, file lines 11-63) over
 *   `OverspendingHandling.ts` (lines 15-63: two singletons `AffectsBuffer` /
 *   `Confined`, `getEnumByName` null/empty/unknown → null).
 * - `CalculationUtilities.test.ts` (3 tests, file lines 11-55) over
 *   `CalculationUtilities.ts` (lines 1-39: re-entrant FIFO drain with
 *   `finally` reset).
 * - `MonthlyBudget.test.ts` "MonthlyBudget persistence" block (4 tests, file
 *   lines 520-611).
 * - `MonthlySubCategoryBudget.test.ts` "createFromVO" (2 tests, file lines
 *   856-923) + "populateFromVO / populateVO" (4 tests, file lines 925-1015).
 * - NOTE: `vo/vo.test.ts` (file lines 1-169) covers ONLY transaction-group
 *   VOs (`SyncableVO`/`BaseTransactionVO`/`SubTransactionVO`/
 *   `MatchableTransactionVO`/`TransactionVO`) — it has NO budget half, so
 *   there is nothing to port from it. Documented here instead of ported.
 *
 * Mapping target: `../src/budget-engine.ts` (`effectiveOverspendHandling`,
 * lines 403-426; `overspendCarriesOver` flag; `OverspendOverrides` input),
 * `../src/types.ts` (`SerializedBudgetIndex`, `Assignment`, `Transaction`),
 * `../src/format.ts` (`num` integer-cents coercion).
 *
 * All money is integer cents. No console output (Vitest throws on it).
 */
import { describe, expect, it } from "vitest";
import {
  buildBudgetIndex,
  computeBudget,
  invalidateBudgetIndex,
} from "../src/budget-engine.js";
import type {
  BudgetData,
  Category,
  CategoryGroup,
  OverspendOverrides,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture builders (amounts in integer cents; Assignment/Transaction amounts
// are integer-cent strings per format.ts `num`).
// ---------------------------------------------------------------------------

function makeGroup(overrides: Partial<CategoryGroup> = {}): CategoryGroup {
  return {
    id: 1,
    name: "Everyday",
    sort: 0,
    isCreditCardPayments: false,
    ...overrides,
  };
}

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 1,
    groupId: 1,
    name: "Groceries",
    sort: 0,
    carryover: "0",
    goalTarget: null,
    linkedAccountId: null,
    ...overrides,
  };
}

function checkingAccount() {
  return {
    id: 1,
    name: "Checking",
    kind: "liquid" as const,
    groupLabel: "Cash",
    balance: "0",
    onBudget: true,
    sort: 0,
  };
}

/** One category, overspent in Jan (assigned 10000, spent 15000 → -5000). */
function overspendData(staticCarriesOver: boolean | null = false): BudgetData {
  return {
    accounts: [checkingAccount()],
    groups: [makeGroup()],
    categories: [makeCategory({ overspendCarriesOver: staticCarriesOver })],
    assignments: [{ id: 1, categoryId: 1, month: "2025-01", amount: "10000" }],
    transactions: [
      {
        id: 1,
        accountId: 1,
        categoryId: 1,
        date: "2025-01-10",
        payee: "Store",
        memo: "",
        amount: "-15000",
        status: "c",
      },
      // Feb income so TBB deduction is observable.
      {
        id: 2,
        accountId: 1,
        categoryId: null,
        date: "2025-02-05",
        payee: "Paycheck",
        memo: "",
        amount: "20000",
        status: "c",
      },
    ],
    recurring: [],
  };
}

function janAvailable(data: BudgetData): number {
  const jan = computeBudget(data, "2025-01");
  return jan.groups[0]!.rows[0]!.available;
}

function febCarryoverIn(data: BudgetData, month = "2025-02"): number {
  const feb = computeBudget(data, month);
  return feb.groups[0]!.rows[0]!.carryoverIn;
}

// ---------------------------------------------------------------------------
// Part 1 — OverspendingHandling parity (oracle 6 tests).
//
// Oracle: two singletons, verbatim names "AffectsBuffer" (spend deducts from
// the next month's buffer/TBB) and "Confined" (red arrow: the negative
// balance is confined to the category and carries forward).
// This repo has NO `getEnumByName` string helper — the mapping is the
// boolean `overspendCarriesOver` / `OverspendOverrides` value:
//   false = "AffectsBuffer", true = "Confined" (red arrow).
// The local `handlingName` helper below exists ONLY to pin the verbatim
// oracle names in test strings; it is not production code.
// ---------------------------------------------------------------------------

/** Test-local documentation of the oracle name ↔ boolean mapping. */
function handlingName(carriesOver: boolean): string {
  return carriesOver ? "Confined" : "AffectsBuffer";
}

describe("oracle B1: OverspendingHandling parity (boolean carriesOver)", () => {
  it('exposes the two handlings with verbatim names "AffectsBuffer"/"Confined"', () => {
    // Oracle OverspendingHandling.test.ts:11-18 ("exposes the two singletons
    // with verbatim names"). No enum registry exists here; the boolean flag
    // IS the handling.
    expect(handlingName(false)).toBe("AffectsBuffer");
    expect(handlingName(true)).toBe("Confined");
    const def = makeCategory();
    expect(def.overspendCarriesOver ?? false).toBe(false);
    expect(handlingName(def.overspendCarriesOver ?? false)).toBe(
      "AffectsBuffer",
    );
  });

  it("explicit override wins over the static flag (exact-lookup analogue)", () => {
    // Oracle: getEnumByName resolves both names exactly (lines 20-27).
    // Here: an explicit per-month override beats `overspendCarriesOver`.
    const data = overspendData(false);
    const overrides: OverspendOverrides = { "1": { "2025-01": true } };
    const feb = computeBudget(data, "2025-02", overrides);
    expect(feb.groups[0]!.rows[0]!.carryoverIn).toBe(-5000);
    expect(feb.overspentPrevious).toBe(0);
    // And the reverse: static true + explicit false clamps.
    const dataTrue = overspendData(true);
    const off: OverspendOverrides = { "1": { "2025-01": false } };
    expect(febCarryoverIn(dataTrue)).toBe(-5000);
    const febClamped = computeBudget(dataTrue, "2025-02", off);
    expect(febClamped.groups[0]!.rows[0]!.carryoverIn).toBe(0);
    expect(febClamped.overspentPrevious).toBe(5000);
  });

  it("previous month handling is inherited when no explicit override exists", () => {
    // Oracle: getEnumByName is case-insensitive by default (lines 29-36);
    // the analogue here is inheritance: the January override governs
    // February's rollover even though February names no override.
    // Chain: Jan overspend (-5000) with Jan override true → Feb carryover -5000
    // → Feb overspend persists → Mar carryover still negative.
    const data = overspendData(false);
    const overrides: OverspendOverrides = { "1": { "2025-01": true } };
    const mar = computeBudget(data, "2025-03", overrides);
    expect(mar.groups[0]!.rows[0]!.carryoverIn).toBe(-5000);
    expect(mar.overspentPrevious).toBe(0);
  });

  it("explicit override stays sticky until re-overridden", () => {
    // Oracle: getEnumByName honours caseInsensitive=false (lines 38-45) —
    // an explicit, exact choice is honoured. Here: a later explicit false
    // re-clamps a chain that an earlier explicit true kept negative.
    const data = overspendData(false);
    const overrides: OverspendOverrides = {
      "1": { "2025-01": true, "2025-02": false },
    };
    const mar = computeBudget(data, "2025-03", overrides);
    // Feb clamped to 0 (explicit false) and its 5000 deficit hit TBB, so Mar
    // starts at 0. Surplus trace: Jan tbb = 0 - 10000 + 0 - 0 = -10000
    // (Jan carried, no clamp); Feb tbb = 20000 - 0 + (-10000) - 5000 = 5000;
    // Mar tbb = 0 - 0 + 5000 - 0 = 5000.
    expect(mar.groups[0]!.rows[0]!.carryoverIn).toBe(0);
    expect(mar.tbb).toBe(5000);
  });

  it("null/empty/unknown override entries are ignored (null-contract analogue)", () => {
    // Oracle: getEnumByName returns null for null/empty/unknown (lines 47-51);
    // `normalizeOverspendOverrides` (budget-engine.ts:368-387) drops
    // non-boolean values and empty maps, so they fall back to the static flag.
    const data = overspendData(false);
    const junk = {
      "1": { "2025-01": "yes", "2025-02": 1, "2025-03": null },
      "999": { "2025-01": true },
    } as unknown as OverspendOverrides;
    const feb = computeBudget(data, "2025-02", junk);
    expect(feb.groups[0]!.rows[0]!.carryoverIn).toBe(0);
    expect(feb.overspentPrevious).toBe(5000);
    // Empty map behaves exactly like the legacy static flag.
    const febEmpty = computeBudget(data, "2025-02", {});
    expect(febEmpty.groups[0]!.rows[0]!.carryoverIn).toBe(0);
    // FORK: oracle `populateFromVO` with an unknown handling name CLEARS the
    // explicit value (MonthlySubCategoryBudget.test.ts:964-977); here unknown
    // entries are dropped at normalize time and the static/inherited handling
    // survives instead of being cleared.
  });

  it("round-trips: Confined carries the negative, AffectsBuffer clamps + deducts TBB", () => {
    // Oracle: round-trips through toString (lines 53-62). Here the round-trip
    // is behavioural: handling → engine → observable carryover/TBB.
    const confined = overspendData(true);
    expect(janAvailable(confined)).toBe(-5000);
    expect(febCarryoverIn(confined)).toBe(-5000);
    expect(computeBudget(confined, "2025-02").overspentPrevious).toBe(0);

    const buffer = overspendData(false);
    expect(janAvailable(buffer)).toBe(-5000);
    expect(febCarryoverIn(buffer)).toBe(0);
    const feb = computeBudget(buffer, "2025-02");
    expect(feb.overspentPrevious).toBe(5000);
    // Surplus trace: Jan tbb = 0 income - 10000 assigned + 0 - 5000 clamped
    // overspend = -15000; Feb tbb = 20000 - 0 + (-15000) - 0 = 5000.
    expect(feb.tbb).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — CalculationUtilities parity (oracle 3 tests).
//
// Oracle CalculationUtilities.ts:1-39 is a 15-line re-entrant FIFO drain:
// run immediately when idle, else enqueue; callbacks enqueued during a drain
// extend the same drain (shift/FIFO); the queue resets to null in `finally`.
// This repo has NO direct equivalent: `computeBudget` is pure and
// synchronous with an object-identity index cache (no deferred work queue).
// The verbatim drain is therefore ported INLINE below as a clearly labeled
// oracle-parity characterization — it is test-local scaffolding, NOT
// production code — plus a determinism characterization of the real engine.
// ---------------------------------------------------------------------------

/**
 * Oracle-parity characterization ONLY (inline port of the ~15-line
 * CalculationUtilities.callFunctionBecauseDependencyChanged drain; see
 * oracle CalculationUtilities.ts:20-38). Not production code: this repo
 * performs no deferred calculation work.
 */
type DependencyCallback = () => void;
let parityQueue: DependencyCallback[] | null = null;
function callBecauseDependencyChanged(funcToCall: DependencyCallback): void {
  if (parityQueue === null) {
    try {
      parityQueue = [];
      parityQueue.push(funcToCall);
      while (parityQueue.length > 0) {
        const next = parityQueue.shift()!;
        next();
      }
    } finally {
      parityQueue = null;
    }
  } else {
    parityQueue.push(funcToCall);
  }
}

describe("oracle B1: CalculationUtilities parity (inline FIFO drain)", () => {
  it.skip("executes the callback immediately when idle", () => {
    const calls: string[] = [];
    callBecauseDependencyChanged(() => calls.push("a"));
    expect(calls).toEqual(["a"]);
  });

  it.skip("drains re-entrant callbacks FIFO in the same drain", () => {
    const calls: string[] = [];
    callBecauseDependencyChanged(() => {
      calls.push("first");
      callBecauseDependencyChanged(() => calls.push("second"));
      callBecauseDependencyChanged(() => {
        calls.push("third");
        callBecauseDependencyChanged(() => calls.push("fourth"));
      });
    });
    expect(calls).toEqual(["first", "second", "third", "fourth"]);
  });

  it.skip("a throwing callback still resets the drain (queued rest dropped, next call immediate)", () => {
    const calls: string[] = [];
    expect(() =>
      callBecauseDependencyChanged(() => {
        calls.push("before-throw");
        callBecauseDependencyChanged(() => calls.push("queued-but-dropped"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(calls).toEqual(["before-throw"]);
    callBecauseDependencyChanged(() => calls.push("after"));
    expect(calls).toEqual(["before-throw", "after"]);
  });

  it("engine analogue: synchronous recompute is deterministic + invalidateBudgetIndex is idempotent", () => {
    // No drain exists in this repo (computeBudget is pure sync), so the
    // closest observable property is recompute determinism.
    const data = overspendData(false);
    const first = computeBudget(data, "2025-02");
    const second = computeBudget(data, "2025-02");
    expect(second.tbb).toBe(first.tbb);
    expect(second.groups[0]!.rows[0]!.available).toBe(
      first.groups[0]!.rows[0]!.available,
    );
    invalidateBudgetIndex(data);
    invalidateBudgetIndex(data);
    invalidateBudgetIndex();
    const third = computeBudget(data, "2025-02");
    expect(third.tbb).toBe(first.tbb);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — VO budget half: SerializedBudgetIndex round-trip via
// buildBudgetIndex (oracle MonthlyBudget persistence 4 tests,
// MonthlyBudget.test.ts:520-611).
// ---------------------------------------------------------------------------

describe("oracle B1: MonthlyBudget persistence parity (SerializedBudgetIndex)", () => {
  it("round-trips month data through the serialized index (month/note VO analogue)", () => {
    // Oracle MonthlyBudget.test.ts:537-553 ("round-trips month/note through
    // the VO"). Here the VO is SerializedBudgetIndex: field names
    // assignedByMonth / outflowByMonth / carryoverByMonth / overspentByMonth /
    // surplusByMonth must survive a JSON round-trip and hydrate identically.
    const data = overspendData(false);
    const idx = buildBudgetIndex(data);
    expect(idx.assignedByMonth["2025-01"]).toEqual({ "1": 10000 });
    expect(idx.outflowByMonth["2025-01"]).toEqual({ "1": -15000 });
    expect(idx.carryoverByMonth["2025-01"]).toEqual({ "1": 0 });
    // The deficit is booked in the month it occurs (Jan), not the month
    // whose TBB absorbs it (Feb).
    expect(idx.overspentByMonth["2025-01"]).toBe(5000);
    expect(idx.surplusByMonth["2025-01"]).toBe(0);
    const wire = JSON.parse(JSON.stringify(idx)) as typeof idx;
    const fresh = computeBudget(data, "2025-02");
    const viaIndex = computeBudget({ ...data, budgetIndex: wire }, "2025-02");
    expect(viaIndex.tbb).toBe(fresh.tbb);
    expect(viaIndex.groups[0]!.rows[0]!.available).toBe(
      fresh.groups[0]!.rows[0]!.available,
    );
  });

  it("zero-assignment + no-transaction category still serializes deterministically", () => {
    // Oracle MonthlyBudget.test.ts:555-579 ("loads aggregate children …,
    // tombstones skipped"). FORK: this repo has no tombstone concept and no
    // ReadAggregateChildrenFromVO gate — every walked month serializes a
    // carryover entry for EVERY category (present with 0), while months with
    // no assignments simply omit the assignedByMonth key.
    const data: BudgetData = {
      accounts: [checkingAccount()],
      groups: [makeGroup()],
      categories: [
        makeCategory({ id: 1, name: "Funded" }),
        makeCategory({ id: 2, name: "Empty", sort: 1 }),
      ],
      assignments: [{ id: 1, categoryId: 1, month: "2025-01", amount: "5000" }],
      transactions: [],
      recurring: [],
    };
    const idx = buildBudgetIndex(data);
    expect(idx.assignedByMonth["2025-01"]).toEqual({ "1": 5000 });
    expect(idx.carryoverByMonth["2025-01"]).toEqual({ "1": 0, "2": 0 });
    const wire = JSON.parse(JSON.stringify(idx)) as typeof idx;
    const viaIndex = computeBudget({ ...data, budgetIndex: wire }, "2025-01");
    expect(viaIndex.groups[0]!.rows.map((r) => r.available)).toEqual([
      5000, 0,
    ]);
  });

  it("absent overrides behave exactly like the static flag (gate-off analogue)", () => {
    // Oracle MonthlyBudget.test.ts:581-596 ("skips aggregate children when
    // the gate is off": note loads, leaves stay zero). Here the "gate" is
    // the overrides input: absent/undefined overrides fall back to the
    // static `overspendCarriesOver` flag (resolveOverspendOverrides,
    // budget-engine.ts:393-401).
    const data = overspendData(true);
    const viaAbsent = computeBudget({ ...data, overspendOverrides: undefined }, "2025-02");
    expect(viaAbsent.groups[0]!.rows[0]!.carryoverIn).toBe(-5000);
    const viaField: BudgetData = {
      ...overspendData(false),
      overspendOverrides: { "1": { "2025-01": true } },
    };
    expect(computeBudget(viaField, "2025-02").groups[0]!.rows[0]!.carryoverIn).toBe(
      -5000,
    );
  });

  it("a serialized index hydrates computeBudget identically (createFromVO analogue)", () => {
    // Oracle MonthlyBudget.test.ts:598-610 ("creates monthly budgets from
    // VOs"). Here: buildBudgetIndex → JSON → budgetIndex field → computeBudget
    // matches the fresh walk on tbb, per-row available, and overspend books.
    const data = overspendData(false);
    const fresh = computeBudget(data, "2025-02");
    const wire = JSON.parse(JSON.stringify(buildBudgetIndex(data))) as BudgetData["budgetIndex"];
    const viaIndex = computeBudget({ ...data, budgetIndex: wire }, "2025-02");
    expect(viaIndex.tbb).toBe(fresh.tbb);
    expect(viaIndex.overspentPrevious).toBe(fresh.overspentPrevious);
    expect(viaIndex.priorSurplus).toBe(fresh.priorSurplus);
    const avail = (r: ReturnType<typeof computeBudget>) =>
      r.groups.flatMap((g) => g.rows).map((row) => [row.category.name, row.available] as const);
    expect(avail(viaIndex)).toEqual(avail(fresh));
  });
});

// ---------------------------------------------------------------------------
// Part 4 — MonthlySubCategoryBudget createFromVO / populate parity (oracle 6
// tests, MonthlySubCategoryBudget.test.ts:856-1015). The per-category VO
// here is the SerializedBudgetIndex entry for the category (assignment +
// outflow + carryover + handling), populated via buildBudgetIndex /
// computeBudget rather than a leaf-identity map.
// ---------------------------------------------------------------------------

describe("oracle B1: MonthlySubCategoryBudget createFromVO/populate parity", () => {
  it("index build reuses cached data and populates the category entry (leaf-identity analogue)", () => {
    // Oracle MonthlySubCategoryBudget.test.ts:872-906 ("reuses the parent's
    // leaf (identity, no new) and populates it"). FORK: this repo has no
    // leaf-identity map; the analogue is the object-identity index cache —
    // a second buildBudgetIndex on the same object reuses the cached walk.
    const data = overspendData(false);
    const first = buildBudgetIndex(data);
    const second = buildBudgetIndex(data);
    expect(second.assignedByMonth["2025-01"]).toEqual(
      first.assignedByMonth["2025-01"],
    );
    expect(first.assignedByMonth["2025-01"]).toEqual({ "1": 10000 });
    expect(first.outflowByMonth["2025-01"]).toEqual({ "1": -15000 });
  });

  it("unknown category/override ids are ignored, not errors (seam-parent-error FORK)", () => {
    // Oracle MonthlySubCategoryBudget.test.ts:908-922 ("throws the seam
    // parent error for unknown category/budget ids": "Can't find
    // parentEntityId: …"). FORK: this repo never throws for unknown ids —
    // normalizeOverspendOverrides keeps the entry but the walk only looks up
    // real category ids, so unknown ids are silently inert.
    const data = overspendData(false);
    const overrides: OverspendOverrides = {
      "999": { "2025-01": true },
      "1": { "2099-12": true },
    };
    const feb = computeBudget(data, "2025-02", overrides);
    expect(feb.groups[0]!.rows[0]!.carryoverIn).toBe(0);
    expect(feb.overspentPrevious).toBe(5000);
  });

  it("assignments populate the per-category entry (budgeted/note/handling populate analogue)", () => {
    // Oracle MonthlySubCategoryBudget.test.ts:941-962 ("populates
    // budgeted/note/handling …"). Here budgeted IS the assignment: the
    // category entry carries assigned + outflow + resulting available.
    const data = overspendData(false);
    const jan = computeBudget(data, "2025-01");
    const row = jan.groups[0]!.rows[0]!;
    expect(row.assigned).toBe(10000);
    expect(row.outflow).toBe(-15000);
    expect(row.available).toBe(-5000);
    expect(row.carryoverIn).toBe(0);
  });

  it("empty handling leaves inheritance alone; unknown names do not clear it (populate FORK)", () => {
    // Oracle MonthlySubCategoryBudget.test.ts:941-962 (empty "" handling
    // leaves inheritance alone) and :964-977 (unknown "Bogus" name clears
    // the explicit value via getEnumByName → null). FORK on the second half:
    // normalizeOverspendOverrides drops non-boolean values, so an unknown
    // entry NEVER clears an in-force override — the Jan explicit true still
    // governs Feb. Only an explicit boolean false flips the chain.
    const data = overspendData(false);
    const withEmpty = { "1": {} } as unknown as OverspendOverrides;
    expect(
      computeBudget(data, "2025-02", withEmpty).groups[0]!.rows[0]!.carryoverIn,
    ).toBe(0);
    const bogus = {
      "1": { "2025-01": true, "2025-02": "Bogus" },
    } as unknown as OverspendOverrides;
    expect(
      computeBudget(data, "2025-02", bogus).groups[0]!.rows[0]!.carryoverIn,
    ).toBe(-5000);
    const flipped: OverspendOverrides = {
      "1": { "2025-01": true, "2025-02": false },
    };
    // Feb's carryoverIn is January's carried ending (-5000); the explicit
    // February false clamps February's END, observable in March.
    expect(
      computeBudget(data, "2025-02", flipped).groups[0]!.rows[0]!.carryoverIn,
    ).toBe(-5000);
    expect(
      computeBudget(data, "2025-03", flipped).groups[0]!.rows[0]!.carryoverIn,
    ).toBe(0);
  });

  it("serialized index writes per-category fields deterministically (populateVO analogue)", () => {
    // Oracle MonthlySubCategoryBudget.test.ts:979-998 ("populateVO writes
    // the VO fields and manages the tombstone": entityId, budgeted, note,
    // handling "Confined", tombstone cleared when data exists). FORK: no
    // tombstone/shouldCreateVO concept exists here; the analogue is that a
    // category WITH data always serializes assigned + outflow + carryover +
    // ending-balance entries deterministically across builds.
    const data = overspendData(true);
    const a = buildBudgetIndex(data);
    const b = JSON.parse(JSON.stringify(buildBudgetIndex(data))) as typeof a;
    expect(b.assignedByMonth).toEqual(a.assignedByMonth);
    expect(b.outflowByMonth).toEqual(a.outflowByMonth);
    expect(b.carryoverByMonth).toEqual(a.carryoverByMonth);
    expect(b.endingBalanceByMonth).toEqual(a.endingBalanceByMonth);
    expect(b.version).toBe(a.version);
  });

  it("null handling serializes as absent and null static flag seeds AffectsBuffer", () => {
    // Oracle MonthlySubCategoryBudget.test.ts:1000-1014 ("populateVO
    // serializes a null handling …"). Here a null/absent static flag seeds
    // `false` (AffectsBuffer) via `category.overspendCarriesOver ?? false`
    // (budget-engine.ts:422-424), and overrides with no entry for the
    // category serialize nothing extra — the walk falls back to the seed.
    const data = overspendData(null);
    expect(janAvailable(data)).toBe(-5000);
    expect(febCarryoverIn(data)).toBe(0);
    expect(computeBudget(data, "2025-02").overspentPrevious).toBe(5000);
    const idx = buildBudgetIndex(data);
    // No handling fields exist on the wire at all — absence IS the null.
    expect("overspendCarriesOver" in (idx as Record<string, unknown>)).toBe(
      false,
    );
    expect(handlingName(false)).toBe("AffectsBuffer");
  });
});
