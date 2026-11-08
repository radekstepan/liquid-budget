/**
 * REPRO ONLY — scheduled-date calendar edges vs YNAB4 overflow (not yet
 * fixed; do not promote).
 *
 * Diverges: YNAB4 `addYear` just bumps the year field, and ActionScript
 * `Date` normalizes the overflow — Feb 29 + 1 year rolls forward to Mar 1.
 * Ours clamps to the last valid day of the target month (Feb 28), so
 * leap-day yearly schedules drift a day behind YNAB4.
 * Monthly / twice-a-month / daily edges were verified to agree with YNAB4
 * (`DateWithoutTime.addMonth` clamps like ours; `addDate` is +N days;
 * `getNextOccurrence` TwiceAMonth matches `nextDateFor`) — dropped, no test.
 *
 * YNAB4: data/ScheduledTransaction.as:57-110 (`getNextOccurrence`: Yearly →
 *   `addYear(startDate, 1)`) + com/ynab/DateWithoutTime.as:104-109
 *   (`addYear`: `retVal.year += amountToAdd`, AS Date rolls Feb 29 → Mar 1).
 * Ours: packages/logic/src/format.ts:800-809 (`yearly` clamps via
 *   `Math.min(anchorDay, lastDay)`) + :790-799 (`every2years`, same clamp).
 */
import { describe, expect, it } from "vitest";
import { nextDateFor } from "../src/format.js";

describe("ynab4 parity: leap-day schedule overflow rolls to Mar 1", () => {
  it("yearly from Feb 29 2024 advances to Mar 1 2025 (YNAB4 addYear rollover)", () => {
    // FAILS today: clamps to Feb 28 instead of rolling to Mar 1.
    expect(nextDateFor("yearly", "2024-02-29", 29)).toBe("2025-03-01");
  });

  it("every2years from Feb 29 2024 advances to Mar 1 2026 (YNAB4 addYear rollover)", () => {
    // FAILS today: clamps to Feb 28 instead of rolling to Mar 1.
    expect(nextDateFor("every2years", "2024-02-29", 29)).toBe("2026-03-01");
  });
});
