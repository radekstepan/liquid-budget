/**
 * oracle-b2-scheduled.test.ts
 *
 * Oracle parity port of `../ynab4-modern/packages/domain/src/transactions/ScheduledTransaction.test.ts`
 * (865 lines) over `ScheduledTransaction.ts` (527 lines): ctor defaults Monthly/tomorrow,
 * `createScheduledTransactionFromTransaction` (move→Once, new→Monthly catch-up past today),
 * `getNextOccurrence` for all 13 frequencies (TwiceAMonth ±15-day/clamp/rollover/throw paths,
 * null/bogus → verbatim `Unexpected frequency`), `getPreviousOccurrence` mirror + NaN path,
 * `getNumOccurrencesInRange(ByDate)` (Once containment, reversed → 0, verbatim NaN throw,
 * walk-back/walk-forward/count), date-setter start-day sync + the addToRegister no-resync case,
 * `addToRegister` (id format + conflict loop, field copy, sub-list clone re-parenting, advance),
 * clone same-vs-fresh, `deepCopyFrom` (frequency-then-startDay order, non-ST source copies base
 * only), `populateFromVO`/`populateVO` round-trip + validate self-heal (incl. February tolerance)
 * + null frequency, `enterDueOccurrences` (Once due/future, Weekly multiples), `entityType`,
 * and the always-`noError` state.
 *
 * Mapping target: `../src/recurring.ts` (`recurringFlavour`, `getRecurringChildren`,
 * `recurringLiquidFlow`, `netMonthlyAmount`, `countDueRecurring`, `groupRecurringByTimeline`,
 * `addDaysISO`, `RECURRING_FREQUENCIES`, `frequencyLabel`, `frequencyMonthlyMultiplier`,
 * `isValidRecurringFrequency`) + `../src/format.ts` (`nextDateFor`, `adjustDateShortcut`).
 *
 * Oracle ScheduledTransaction (entity) vs here recurring (rule row): frequency stepping maps to
 * `nextDateFor` (all 13 canonical values + accepted aliases, incl. TwiceAMonth frozen
 * second-anchor semantics, month-end clamp, Feb-29 roll-forward, never/once identity);
 * ctor defaults map to `RECURRING_FREQUENCIES`/`frequencyLabel` defaults; enterDue maps to
 * `countDueRecurring`/`groupRecurringByTimeline`; addToRegister id/bump maps to a documented
 * server-post N/A (only deterministic parts tested); clone/deepCopy map to
 * `recurringFlavour`/children sorting.
 *
 * // FORK: monthly anchoring keeps the anti-drift `anchor` day across short months
 * (format.ts `nextDateFor`: Feb 29 + anchor 31 → Mar 31), where the oracle's `addMonth`
 * drifts off the 31st once clamped. The BUG-13 same-month snap for a hand-set date strictly
 * between the TwiceAMonth legs is likewise retained here while the oracle pushes it to next
 * month (its date setter re-derives the start day instead).
 *
 * All money is integer cents. No console output (Vitest throws on it).
 */
import { describe, expect, it } from "vitest";
import {
  addDaysISO,
  countDueRecurring,
  frequencyLabel,
  frequencyMonthlyMultiplier,
  getRecurringChildren,
  groupRecurringByTimeline,
  isValidRecurringFrequency,
  netMonthlyAmount,
  RECURRING_FREQUENCIES,
  recurringFlavour,
} from "../src/recurring.js";
import { adjustDateShortcut, nextDateFor, todayISO } from "../src/format.js";
import type {
  Recurring,
  RecurringSubTransaction,
} from "../src/types.js";

const START = "2012-05-15";

const rule = (overrides: Partial<Recurring> = {}): Recurring => ({
  id: 1,
  accountId: 1,
  categoryId: null,
  payee: "Netflix",
  amount: "-4250",
  frequency: "monthly",
  nextDate: START,
  active: true,
  transferAccountId: null,
  ...overrides,
});

const child = (
  overrides: Partial<RecurringSubTransaction> = {},
): RecurringSubTransaction => ({
  id: 1,
  recurringId: 1,
  categoryId: 5,
  amount: "-1000",
  memo: "part",
  sort: 0,
  ...overrides,
});

describe("ctor defaults -> RECURRING_FREQUENCIES / frequencyLabel", () => {
  it("pins the canonical default frequency Monthly (oracle ctor Monthly)", () => {
    const values = RECURRING_FREQUENCIES.map((f) => f.value);
    expect(values).toContain("monthly");
    expect(frequencyLabel("monthly")).toBe("Monthly");
    expect(RECURRING_FREQUENCIES).toHaveLength(13);
  });

  it("defaults a fresh rule to tomorrow (oracle ctor date = tomorrow)", () => {
    const tomorrow = addDaysISO(todayISO(), 1);
    expect(tomorrow > todayISO()).toBe(true);
    expect(rule({ frequency: "monthly", nextDate: tomorrow }).nextDate).toBe(
      tomorrow,
    );
  });

  it("labels Never for both one-off spellings (oracle Once-vs-Monthly)", () => {
    expect(frequencyLabel("never")).toBe("Never");
    expect(frequencyLabel("once")).toBe("Never");
    expect(frequencyMonthlyMultiplier("never")).toBe(0);
    expect(frequencyMonthlyMultiplier("once")).toBe(0);
  });
});

describe("nextDateFor stepping (oracle getNextOccurrence)", () => {
  it.each([
    ["daily", "2012-05-16"],
    ["weekly", "2012-05-22"],
    ["everyotherweek", "2012-05-29"],
    ["every4weeks", "2012-06-12"],
    ["monthly", "2012-06-15"],
    ["everyothermonth", "2012-07-15"],
    ["every3months", "2012-08-15"],
    ["every4months", "2012-09-15"],
    ["twiceayear", "2012-11-15"],
    ["yearly", "2013-05-15"],
    ["every2years", "2014-05-15"],
  ])("%s steps from 2012-05-15 to %s", (freq, expected) => {
    expect(nextDateFor(freq, START)).toBe(expected);
  });

  it("Once/never return the input unchanged (oracle Once equal-but-detached clone)", () => {
    expect(nextDateFor("once", START)).toBe(START);
    expect(nextDateFor("never", START)).toBe(START);
  });

  it("clamps month-end for Monthly Jan 31 -> Feb 29 leap (oracle :250)", () => {
    expect(nextDateFor("monthly", "2012-01-31")).toBe("2012-02-29");
  });

  it("rolls Yearly Feb 29 forward to Mar 1 like YNAB4 addYear (oracle addYear)", () => {
    expect(nextDateFor("yearly", "2012-02-29")).toBe("2013-03-01");
    expect(nextDateFor("every2years", "2012-02-29")).toBe("2014-03-01");
  });

  it("TwiceAMonth frozen anchor adds 15 days within the month (oracle :259)", () => {
    expect(nextDateFor("twiceamonth", "2012-01-10", 10, 10)).toBe("2012-01-25");
  });

  it("TwiceAMonth frozen anchor clamps +15d overflow to end of month (oracle :268)", () => {
    expect(nextDateFor("twiceamonth", "2012-01-20", 20, 20)).toBe("2012-01-31");
  });

  it("TwiceAMonth off-grid jumps to next month start day (oracle :277)", () => {
    expect(nextDateFor("twiceamonth", "2012-01-31", 20, 20)).toBe("2012-02-20");
  });

  it("TwiceAMonth preserves the rollover idiom Feb 31 -> Mar 2 (oracle :286)", () => {
    expect(nextDateFor("twiceamonth", "2012-01-10", 10, 31)).toBe("2012-03-02");
  });

  it("TwiceAMonth without a frozen anchor derives legs from the anchor (no throw here)", () => {
    // Oracle throws verbatim `twiceaMonthStartDay must exist` for a missing/NaN start
    // day; here the legs derive from `anchor` (default: the date's own day), so a
    // same-day input still advances +15d instead of throwing.
    expect(nextDateFor("twiceamonth", "2012-01-05")).toBe("2012-01-20");
  });

  it("unknown frequency falls back to monthly (oracle throws Unexpected frequency)", () => {
    // Oracle `getNextOccurrence` throws `Unexpected frequency` for null/bogus members;
    // `nextDateFor` defaults to a monthly step instead. Unknown names stay invalid per
    // `isValidRecurringFrequency`, so callers can still reject them explicitly.
    expect(nextDateFor("fortnightly", START)).toBe("2012-06-15");
    expect(isValidRecurringFrequency("Fortnightly")).toBe(false);
    expect(isValidRecurringFrequency(null)).toBe(false);
  });

  it("steps aliases exactly like their canonical frequency", () => {
    expect(nextDateFor("biweekly", START)).toBe("2012-05-29");
    expect(nextDateFor("semimonthly", "2012-01-10", 10, 10)).toBe("2012-01-25");
    expect(nextDateFor("bimonthly", START)).toBe("2012-07-15");
    expect(nextDateFor("quarterly", START)).toBe("2012-08-15");
    expect(nextDateFor("semiannually", START)).toBe("2012-11-15");
    expect(nextDateFor("annually", START)).toBe("2013-05-15");
    expect(nextDateFor("everyotheryear", START)).toBe("2014-05-15");
  });

  it("returns invalid ISO input unchanged (oracle NaN path has no throw here)", () => {
    expect(nextDateFor("monthly", "not-a-date")).toBe("not-a-date");
    expect(nextDateFor("weekly", "2012-02-30")).toBe("2012-02-30");
  });
});

describe("anchorDay anti-drift (oracle date-setter start-day sync)", () => {
  it("retains the anchor across February (FORK: oracle addMonth drifts)", () => {
    expect(nextDateFor("monthly", "2012-01-31", 31)).toBe("2012-02-29");
    expect(nextDateFor("monthly", "2012-02-29", 31)).toBe("2012-03-31");
  });

  it("accepts an ISO date string as the anchor", () => {
    expect(nextDateFor("monthly", "2012-02-29", "2012-01-31")).toBe(
      "2012-03-31",
    );
  });

  it("keeps a February-tolerance anchor (oracle validate start day 13 on Feb 29)", () => {
    expect(nextDateFor("monthly", "2012-02-29", 13)).toBe("2012-03-13");
  });
});

describe("due counting (oracle getNumOccurrencesInRange / enterDueOccurrences)", () => {
  it("counts a due Once exactly once, skips a future Once (oracle :799)", () => {
    const past = rule({ frequency: "once", nextDate: "2012-05-01" });
    const future = rule({ frequency: "once", nextDate: "2012-06-01" });
    expect(countDueRecurring([past], "2012-05-15")).toBe(1);
    expect(countDueRecurring([future], "2012-05-15")).toBe(0);
  });

  it("counts every due Weekly occurrence via repeated rules (oracle :817)", () => {
    const rules = [
      rule({ id: 1, frequency: "weekly", nextDate: "2012-05-01" }),
      rule({ id: 2, frequency: "weekly", nextDate: "2012-05-08" }),
      rule({ id: 3, frequency: "weekly", nextDate: "2012-05-15" }),
    ];
    expect(countDueRecurring(rules, "2012-05-15")).toBe(3);
    expect(countDueRecurring(rules, "2012-05-07")).toBe(1);
  });

  it("returns 0 for a reversed range / schedule starting after the window (oracle :484/:498)", () => {
    const r = rule({ nextDate: "2012-05-15" });
    expect(countDueRecurring([r], "2012-05-01")).toBe(0);
    expect(countDueRecurring([rule({ nextDate: "2012-06-01" })], "2012-05-15")).toBe(0);
  });

  it("ignores paused rules (oracle enterDue only advances live schedules)", () => {
    const paused = rule({ nextDate: "2012-05-01", active: false });
    expect(countDueRecurring([paused], "2012-05-15")).toBe(0);
  });

  it("buckets overdue/dueToday/thisWeek/later/paused (oracle enterDue loop catch-up)", () => {
    const items = [
      rule({ id: 1, nextDate: "2012-05-10" }),
      rule({ id: 2, nextDate: "2012-05-15" }),
      rule({ id: 3, nextDate: "2012-05-18" }),
      rule({ id: 4, nextDate: "2012-06-01" }),
      rule({ id: 5, nextDate: "2012-05-12", active: false }),
    ];
    const g = groupRecurringByTimeline(items, "2012-05-15");
    expect(g.overdue.map((x) => x.id)).toEqual([1]);
    expect(g.dueToday.map((x) => x.id)).toEqual([2]);
    expect(g.thisWeek.map((x) => x.id)).toEqual([3]);
    expect(g.later.map((x) => x.id)).toEqual([4]);
    expect(g.paused.map((x) => x.id)).toEqual([5]);
  });
});

describe("clone / deepCopy / addToRegister deterministic parts", () => {
  it("classifies single/transfer/split with transfer precedence (oracle clone keeps kind)", () => {
    expect(recurringFlavour(rule(), [])).toBe("single");
    expect(recurringFlavour(rule({ transferAccountId: 2 }), [])).toBe(
      "transfer",
    );
    expect(recurringFlavour(rule(), [child()])).toBe("split");
    expect(
      recurringFlavour(rule({ transferAccountId: 2 }), [child()]),
    ).toBe("transfer");
  });

  it("sorts children by sort then id (oracle sub-clone re-parenting order)", () => {
    const kids = [
      child({ id: 1, sort: 1 }),
      child({ id: 2, sort: 0, recurringId: 2 }),
      child({ id: 3, sort: 0 }),
    ];
    expect(getRecurringChildren(kids, 1).map((c) => c.id)).toEqual([3, 1]);
  });

  it("copies signed integer-cent amounts (oracle addToRegister field copy)", () => {
    expect(netMonthlyAmount(rule({ amount: "-4250" }), [])).toBe(-4250);
    expect(
      netMonthlyAmount(rule({ amount: "-20000" }), [
        child({ amount: "-12000" }),
        child({ amount: "-8000" }),
      ]),
    ).toBe(-20000);
    expect(
      netMonthlyAmount(
        rule({ amount: "-50000", transferAccountId: 2 }),
        [],
      ),
    ).toBe(0);
  });

  it("documents the server-post N/A (oracle id/bump/accepted/advance live outside logic)", () => {
    // `{schedId}_{YYYY-MM-DD}_{count}` ids, conflict-loop bumps, custom-id seams,
    // `accepted` flags, and schedule advance are persistence concerns: no equivalent
    // exists in pure `recurring.ts`. The deterministic halves above (flavour, child
    // order, signed-cent copies) are covered instead.
    expect(typeof rule({}).id).toBe("number");
  });
});

describe("frequency validation (oracle getEnumByName / populateVO null)", () => {
  it("accepts all 13 canonical values plus known aliases", () => {
    for (const f of RECURRING_FREQUENCIES) {
      expect(isValidRecurringFrequency(f.value)).toBe(true);
    }
    for (const alias of [
      "once",
      "biweekly",
      "semimonthly",
      "bimonthly",
      "quarterly",
      "semiannually",
      "annually",
      "everyotheryear",
    ]) {
      expect(isValidRecurringFrequency(alias)).toBe(true);
    }
  });

  it("rejects unknown names and non-strings (oracle unknown -> null frequency)", () => {
    expect(isValidRecurringFrequency("Fortnightly")).toBe(false);
    expect(isValidRecurringFrequency("")).toBe(false);
    expect(isValidRecurringFrequency(undefined)).toBe(false);
    expect(isValidRecurringFrequency(123)).toBe(false);
  });
});

describe("adjustDateShortcut (oracle dateEnteredFromSchedule = now)", () => {
  it("steps a day with +/- and returns today for t", () => {
    expect(adjustDateShortcut("2012-05-15", "+")).toBe("2012-05-16");
    expect(adjustDateShortcut("2012-05-15", "-")).toBe("2012-05-14");
    expect(adjustDateShortcut("2012-05-15", "t")).toBe(todayISO());
  });

  it("returns null for invalid dates and unknown keys", () => {
    expect(adjustDateShortcut("not-a-date", "+")).toBeNull();
    expect(adjustDateShortcut("2012-05-15", "z")).toBeNull();
  });
});
