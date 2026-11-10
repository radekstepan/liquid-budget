/**
 * Oracle B5 — date handling ported from
 * `ynab4-modern/packages/domain/src/DateWithoutTime.test.ts` (8 tests).
 *
 * Mapping (oracle test → this repo):
 * - round-trip YYYY-MM-DD (oracle:5-10) → `isValidISODate` + `monthKey`/`parseMonthKey`
 * - month-end clamp Jan31+1mo→Feb28, Mar31-1mo→Feb28 (oracle:12-19) → `nextDateFor` monthly clamp
 * - day-0 idiom getLastOfMonth (oracle:21-27) → N/A (plain `new Date(Date.UTC(y,m+1,0))`
 *   JS idiom usable directly; pinned + last-day derivation via `nextDateFor` clamp)
 * - ordering/compare/getDaysSeparating (oracle:29-37) → ISO string comparison + `addDaysISO`
 * - 2-digit-year pivot at 70 (oracle:39-42; ctor pivot `DateWithoutTime.ts:23-25`) →
 *   csv-import `expandYear` pivot (`csv-import.ts:195-200`). NOTE divergence: oracle
 *   `parseMMDDYY` (`DateWithoutTime.ts:131-139`) does `year += 2000` unconditionally
 *   (70→2070), while csv-import pivots at 70 (70→1970). This file pins csv-import.
 * - MM/DD/YY parse 1/5/14→2014-01-05, nope→null (oracle:44-49) → `parseDate` matrix
 * - UTC-ms → formattable wall-clock Date (oracle:51-60) and getFormattableDate
 *   (oracle:61-71) → N/A (no Flex `DateFormatter` here); pinned via local-`Date`
 *   getters + `todayISO` local-timezone guard.
 * - month enumeration → budget-engine `getMonthsWithData` (assignments + tx dates).
 */
import { describe, expect, it, vi } from "vitest";
import {
  adjustDateShortcut,
  isValidISOMonth,
  isValidISODate,
  monthKey,
  nextDateFor,
  nextMonthKey,
  parseMonthKey,
  prevMonthKey,
  todayISO,
} from "../src/format.js";
import { addDaysISO as addDaysISORecurring } from "../src/recurring.js";
import { parseDate } from "../src/csv-import.js";
import { getMonthsWithData } from "../src/budget-engine.js";
import type { BudgetData } from "../src/types.js";

describe("oracle B5: on-disk YYYY-MM-DD round-trip (DateWithoutTime.test.ts:5-10)", () => {
  it("accepts the on-disk form and round-trips the month key", () => {
    expect(isValidISODate("2014-01-05")).toBe(true);
    const key = monthKey(2014, 0);
    expect(key).toBe("2014-01");
    expect(parseMonthKey(key)).toEqual({ year: 2014, month0: 0 });
    expect(isValidISOMonth(key)).toBe(true);
  });

  it("rejects non-calendar dates behind the round-trip guard", () => {
    expect(isValidISODate("2014-02-30")).toBe(false);
    expect(isValidISODate("2014-13-01")).toBe(false);
    expect(isValidISODate("2014-1-5")).toBe(false);
    expect(isValidISODate("nope")).toBe(false);
  });
});

describe("oracle B5: month-end clamp (DateWithoutTime.test.ts:12-19)", () => {
  it("clamps Jan 31 + 1 month to Feb 28 in a non-leap year", () => {
    expect(nextDateFor("monthly", "2014-01-31")).toBe("2014-02-28");
  });

  it("clamps Jan 31 + 1 month to Feb 29 in a leap year", () => {
    expect(nextDateFor("monthly", "2024-01-31")).toBe("2024-02-29");
  });

  it("restores the anchor day after February (Mar 31 side of the oracle case)", () => {
    expect(nextDateFor("monthly", "2014-02-28", 31)).toBe("2014-03-31");
    expect(nextDateFor("monthly", "2014-02-28", "2014-01-31")).toBe("2014-03-31");
  });
});

describe("oracle B5: day-0 last-day idiom (DateWithoutTime.test.ts:21-27)", () => {
  it("documents N/A: plain JS day-0 idiom is usable directly", () => {
    // No getLastOfMonth wrapper exists here; the underlying
    // `new Date(Date.UTC(y, m + 1, 0))` idiom works as-is.
    expect(new Date(Date.UTC(2014, 0 + 1, 0)).getUTCDate()).toBe(31);
    expect(new Date(Date.UTC(2014, 1 + 1, 0)).getUTCDate()).toBe(28);
    expect(new Date(Date.UTC(2024, 1 + 1, 0)).getUTCDate()).toBe(29);
  });

  it("derives month-end via the nextDateFor clamp", () => {
    expect(nextDateFor("monthly", "2014-01-15", 31)).toBe("2014-02-28");
    expect(nextDateFor("monthly", "2024-01-15", 31)).toBe("2024-02-29");
  });
});

describe("oracle B5: ordering and day separation (DateWithoutTime.test.ts:29-37)", () => {
  it("orders ISO dates by plain string comparison", () => {
    expect("2014-01-01" < "2014-02-01").toBe(true);
    expect("2014-02-01" > "2014-01-01").toBe(true);
    expect("2014-01-01" <= "2014-01-01").toBe(true);
    expect("2014-01-01".localeCompare("2014-02-01")).toBeLessThan(0);
  });

  it("compares by month via the YYYY-MM prefix", () => {
    expect("2014-01-01".slice(0, 7)).toBe("2014-01-20".slice(0, 7));
    expect("2014-01-01".slice(0, 7)).not.toBe("2014-02-01".slice(0, 7));
    expect(nextMonthKey("2014-01")).toBe("2014-02");
    expect(prevMonthKey("2014-02")).toBe("2014-01");
  });

  it("separates Jan 1 from Feb 1 by 31 days via addDaysISO", () => {
    expect(addDaysISORecurring("2014-01-01", 31)).toBe("2014-02-01");
    const ms =
      Date.parse("2014-02-01T00:00:00Z") - Date.parse("2014-01-01T00:00:00Z");
    expect(ms / 86400000).toBe(31);
  });
});

describe("oracle B5: 2-digit-year pivot at 70 (DateWithoutTime.test.ts:39-42)", () => {
  it("pins the csv-import pivot: 69 → 2069, 70 → 1970", () => {
    expect(parseDate("01/05/69", "dmy")).toBe("2069-05-01");
    expect(parseDate("01/05/70", "dmy")).toBe("1970-05-01");
  });

  it("pins the pivot across numeric and text-month forms", () => {
    expect(parseDate("31/12/99", "dmy")).toBe("1999-12-31");
    expect(parseDate("02/01/50", "dmy")).toBe("2050-01-02");
    expect(parseDate("12/31/68", "mdy")).toBe("2068-12-31");
    expect(parseDate("15-Aug-26")).toBe("2026-08-15");
    expect(parseDate("Aug 15, 99")).toBe("1999-08-15");
  });
});

describe("oracle B5: MM/DD/YY parsing (DateWithoutTime.test.ts:44-49)", () => {
  it("parses month-first 1/5/14 to 2014-01-05 under mdy", () => {
    expect(parseDate("1/5/14", "mdy")).toBe("2014-01-05");
  });

  it("returns null for garbage and calendar-invalid input", () => {
    expect(parseDate("nope")).toBeNull();
    expect(parseDate("13/01/14", "mdy")).toBeNull();
    expect(parseDate("2/30/14", "mdy")).toBeNull();
  });
});

describe("oracle B5: formattable wall-clock date (DateWithoutTime.test.ts:51-71)", () => {
  it("documents N/A: local-Date getters already show the wall clock", () => {
    // No convertToFormattableDate/getFormattableDate wrapper exists here
    // (no Flex DateFormatter consumer); constructing a local Date keeps the
    // calendar day deterministically in any host TZ.
    const local = new Date(2014, 0, 5);
    expect(local.getFullYear()).toBe(2014);
    expect(local.getMonth()).toBe(0);
    expect(local.getDate()).toBe(5);
  });

  it("todayISO renders the local (not UTC) calendar day", () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isValidISODate(todayISO())).toBe(true);
    const realOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = () => 420; // PDT, UTC-7
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T04:30:00Z"));
    try {
      expect(todayISO()).toBe("2026-08-05");
    } finally {
      vi.useRealTimers();
      Date.prototype.getTimezoneOffset = realOffset;
    }
  });
});

describe("oracle B5: date shortcuts step ISO days", () => {
  it("steps days and clamps month/year advances", () => {
    expect(adjustDateShortcut("2014-01-31", "+")).toBe("2014-02-01");
    expect(adjustDateShortcut("2014-02-01", "-")).toBe("2014-01-31");
    expect(adjustDateShortcut("2014-01-31", "m")).toBe("2014-02-28");
    expect(adjustDateShortcut("2024-02-29", "y")).toBe("2025-02-28");
  });
});

describe("oracle B5: months-with-data enumeration", () => {
  it("unions assignment, transaction, and income months sorted", () => {
    const data = {
      assignments: [{ month: "2026-08" }, { month: "2026-06" }],
      transactions: [
        { date: "2026-07-15" },
        { date: "2026-08-02", incomeMonth: "2026-09" },
      ],
    } as unknown as BudgetData;
    expect(getMonthsWithData(data)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
  });
});
