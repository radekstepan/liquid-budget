/**
 * Regression: twice-a-month off-grid phase holds into the next month.
 *
 * Pins YNAB4 (`ScheduledTransaction.as:57-206`):
 * - `twiceAMonthStartDay` is derived from the date whenever the date is set
 *   (`resetTwiceAMonthStartDay`, :129-161) but FROZEN while posting
 *   (`updateTwiceAMonthStartDay = false` in `addToRegister`, :203-204), so the
 *   second leg stays pinned to the original phase.
 * - `getNextOccurrence` for TwiceAMonth (:81-100): if the current date equals
 *   the start day, jump +15 (clamped to end-of-month); otherwise jump to
 *   (next month, start day). There is no "snap forward within the same month"
 *   branch — an off-grid date always advances into the next month.
 *
 * Fix commit: 6b48aa7 (g-twiceamonth-phase).
 */
import { describe, expect, it } from "vitest";
import { nextDateFor } from "../src/format.js";

describe("ynab4 parity: twiceamonth off-grid phase (YNAB4 ScheduledTransaction.as)", () => {
  it("off-grid 2026-03-15 with anchor 31 advances to 2026-04-16 (YNAB4 freezes startDay during post)", () => {
    // YNAB4: 03-15 != startDay(16, from 31-15) -> next is (April, 16).
    expect(nextDateFor("twiceamonth", "2026-03-15", 31)).toBe("2026-04-16");
  });

  it("Feb 15 with anchor 31 advances to 2026-03-16 (YNAB4), not clamped 2026-02-16", () => {
    // Imported/clamped February leg: YNAB4 holds the phase into next month.
    expect(nextDateFor("twiceamonth", "2026-02-15", 31)).toBe("2026-03-16");
  });
});
