import { describe, expect, it, vi } from "vitest";
import { dollarsToCents, evalAmount, fmt, fmtSigned, monthKey, monthLabel, nextDateFor, num, parseMonthKey, prevMonthKey, previousMonthKey, round2, todayISO, adjustDateShortcut } from "../src/format.js";

describe("format", () => {
  it("fmt signs negative numbers and formats cents as dollars", () => {
    expect(fmt(0)).toBe("$0.00");
    expect(fmt(12300)).toBe("$123.00");
    expect(fmt(-12300)).toBe("-$123.00");
    expect(fmt(123450)).toBe("$1,234.50");
  });

  it("fmt handles large numbers with comma separators", () => {
    expect(fmt(123456789)).toBe("$1,234,567.89");
    expect(fmt(-123456789)).toBe("-$1,234,567.89");
  });

  it("fmtSigned shows zero as $0.00", () => {
    expect(fmtSigned(0)).toBe("$0.00");
    expect(fmtSigned(-500)).toBe("-$5.00");
  });

  it("num parses integer strings and handles nullish/NaN", () => {
    expect(num("314")).toBe(314);
    expect(num(700)).toBe(700);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num("not a number")).toBe(0);
  });

  it("num handles negative integer strings", () => {
    expect(num("-4250")).toBe(-4250);
    expect(num("-0")).toBe(0);
  });

  it("num handles formatted currency strings with symbols and commas (UNI-47 / BUG-40)", () => {
    expect(num("$1,234")).toBe(1234);
    expect(num("-$500")).toBe(-500);
    expect(num("$-500")).toBe(-500);
    expect(num("$ 3,456")).toBe(3456);
    expect(num("€100")).toBe(100);
    expect(num("£2,500")).toBe(2500);
    expect(num("(750)")).toBe(-750);
    expect(num("+ $1,000")).toBe(1000);
  });

  it("num handles fractional numbers and fractional strings with consistent rounding", () => {
    expect(num(100.5)).toBe(101);
    expect(num("100.5")).toBe(101);
    expect(num("4.03")).toBe(4);
    expect(num("4.6")).toBe(5);
    expect(num("-100.5")).toBe(-101);
    expect(num("$-100.5")).toBe(-101);
    expect(num("(100.5)")).toBe(-101);
    expect(num("+100.5")).toBe(101);
  });

  it("num throws RangeError on integer overflow beyond MAX_SAFE_INTEGER and large scientific notation", () => {
    expect(() => num("9007199254740992")).toThrow(RangeError);
    expect(() => num("1e21")).toThrow(RangeError);
    expect(() => num(Number.MAX_SAFE_INTEGER + 100)).toThrow(RangeError);
    expect(() => num(1e21)).toThrow(RangeError);
  });

  it("dollarsToCents converts dollar amounts to integer cents", () => {
    expect(dollarsToCents(3.14)).toBe(314);
    expect(dollarsToCents(-42.50)).toBe(-4250);
    expect(dollarsToCents(0)).toBe(0);
    expect(dollarsToCents(null)).toBe(0);
  });

  it("dollarsToCents throws RangeError on overflow", () => {
    expect(() => dollarsToCents(1e16)).toThrow(RangeError);
  });

  it("monthKey zero-pads single-digit months", () => {
    expect(monthKey(2025, 0)).toBe("2025-01");
    expect(monthKey(2025, 11)).toBe("2025-12");
  });

  it("parseMonthKey inverts monthKey", () => {
    for (let m = 0; m < 12; m++) {
      const k = monthKey(2025, m);
      const parsed = parseMonthKey(k);
      expect(parsed.year).toBe(2025);
      expect(parsed.month0).toBe(m);
    }
  });

  it("monthKey / parseMonthKey round-trip across year boundary", () => {
    const dec = parseMonthKey("2025-12");
    const total = dec.year * 12 + dec.month0 + 1;
    const nextKey = monthKey(Math.floor(total / 12), total % 12);
    expect(nextKey).toBe("2026-01");
    const parsed = parseMonthKey(nextKey);
    expect(parsed.year).toBe(2026);
    expect(parsed.month0).toBe(0);
  });

  it("monthLabel renders long month + year", () => {
    expect(monthLabel("2025-07")).toBe("July 2025");
    expect(monthLabel("2024-01")).toBe("January 2024");
  });

  it("todayISO returns YYYY-MM-DD", () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("todayISO uses the local timezone, not UTC", () => {
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

  describe("nextDateFor", () => {
    it("advances weekly by 7 days", () => {
      expect(nextDateFor("weekly", "2026-07-01")).toBe("2026-07-08");
      expect(nextDateFor("weekly", "2026-12-30")).toBe("2027-01-06");
    });

    it("advances biweekly by 14 days", () => {
      expect(nextDateFor("biweekly", "2026-07-01")).toBe("2026-07-15");
    });

    it("advances monthly by one month, rolling over year boundary", () => {
      expect(nextDateFor("monthly", "2026-07-15")).toBe("2026-08-15");
      expect(nextDateFor("monthly", "2026-12-15")).toBe("2027-01-15");
    });

    it("clamps to last day when next month is shorter", () => {
      expect(nextDateFor("monthly", "2026-01-31")).toBe("2026-02-28");
    });

    it("advances yearly by one year", () => {
      expect(nextDateFor("yearly", "2026-07-01")).toBe("2027-07-01");
    });

    it("advances twiceamonth correctly (alternating between two anchors 15 days apart)", () => {
      expect(nextDateFor("twiceamonth", "2026-07-01")).toBe("2026-07-16");
      expect(nextDateFor("twiceamonth", "2026-07-16")).toBe("2026-08-01");
      expect(nextDateFor("twiceamonth", "2026-07-15")).toBe("2026-07-30");
      expect(nextDateFor("twiceamonth", "2026-07-30")).toBe("2026-08-15");
      expect(nextDateFor("semimonthly", "2026-07-05")).toBe("2026-07-20");
      expect(nextDateFor("semimonthly", "2026-07-20")).toBe("2026-08-05");
      // Clamping in February
      expect(nextDateFor("twiceamonth", "2026-02-14")).toBe("2026-02-28");
      expect(nextDateFor("twiceamonth", "2026-02-15")).toBe("2026-02-28");
    });

    it("advances daily by 1 day", () => {
      expect(nextDateFor("daily", "2026-07-01")).toBe("2026-07-02");
    });

    it("advances every4weeks by 28 days", () => {
      expect(nextDateFor("every4weeks", "2026-07-01")).toBe("2026-07-29");
    });

    it("falls back to monthly advance for unknown frequencies", () => {
      expect(nextDateFor("every-fortnight-some-day", "2026-07-01")).toBe("2026-08-01");
      expect(nextDateFor("invalid_freq", "2026-10-15")).toBe("2026-11-15");
      expect(nextDateFor("", "2026-10-15")).toBe("2026-11-15");
    });

    it("advances every2years and everyotheryear by 2 years", () => {
      expect(nextDateFor("every2years", "2026-07-01")).toBe("2028-07-01");
      expect(nextDateFor("everyotheryear", "2026-07-01")).toBe("2028-07-01");
    });

    it("returns input unchanged for invalid date", () => {
      expect(nextDateFor("monthly", "not-a-date")).toBe("not-a-date");
    });
  });

  describe("evalAmount", () => {
    it("returns null for nullish / empty input", () => {
      expect(evalAmount(null)).toBeNull();
      expect(evalAmount(undefined)).toBeNull();
      expect(evalAmount("")).toBeNull();
      expect(evalAmount("   ")).toBeNull();
    });

    it("parses plain numbers", () => {
      expect(evalAmount("0")).toBe(0);
      expect(evalAmount("100")).toBe(100);
      expect(evalAmount("3.14")).toBeCloseTo(3.14);
      expect(evalAmount(42)).toBe(42);
    });

    it("evaluates +, -, *, / with correct precedence", () => {
      expect(evalAmount("100 + 50")).toBe(150);
      expect(evalAmount("100 - 50")).toBe(50);
      expect(evalAmount("100 * 2")).toBe(200);
      expect(evalAmount("100 / 4")).toBe(25);
      expect(evalAmount("100 + 50 * 2")).toBe(200);
      expect(evalAmount("2 + 3 * 4")).toBe(14);
    });

    it("honours parentheses", () => {
      expect(evalAmount("(10 + 5) * 2")).toBe(30);
      expect(evalAmount("((1 + 2) * 3) - 1")).toBe(8);
    });

    it("handles unary minus and plus", () => {
      expect(evalAmount("-50 + 100")).toBe(50);
      expect(evalAmount("100 + -50")).toBe(50);
      expect(evalAmount("2 * -3")).toBe(-6);
      expect(evalAmount("(-5)")).toBe(-5);
    });

    it("is left-associative for same-precedence ops", () => {
      expect(evalAmount("10 - 3 - 2")).toBe(5);
      expect(evalAmount("20 / 4 / 5")).toBe(1);
    });

    it("strips $ , _ and whitespace before parsing", () => {
      expect(evalAmount("$1,234.56")).toBeCloseTo(1234.56);
      expect(evalAmount("$1,234.56 + 10")).toBeCloseTo(1244.56);
      expect(evalAmount("1_000 + 500")).toBe(1500);
      expect(evalAmount("  100  +  50  ")).toBe(150);
    });

    it("accepts leading and trailing dots", () => {
      expect(evalAmount(".5")).toBe(0.5);
      expect(evalAmount(".5 + .25")).toBeCloseTo(0.75);
      expect(evalAmount("5.")).toBe(5);
    });

    it("returns null for incomplete expressions", () => {
      expect(evalAmount("100 +")).toBeNull();
      expect(evalAmount("* 5")).toBeNull();
      expect(evalAmount("(")).toBeNull();
      expect(evalAmount("(100 + 50")).toBeNull();
      expect(evalAmount("100 50")).toBeNull();
    });

    it("returns null for invalid characters", () => {
      expect(evalAmount("abc")).toBeNull();
      expect(evalAmount("1; alert(1)")).toBeNull();
      expect(evalAmount("1 + abc")).toBeNull();
      expect(evalAmount("sqrt(4)")).toBeNull();
      expect(evalAmount("2 ^ 3")).toBeNull();
    });

    it("returns null for division by zero", () => {
      expect(evalAmount("100 / 0")).toBeNull();
      expect(evalAmount("0 / 0")).toBeNull();
    });

    it("returns null for double-dot numbers", () => {
      expect(evalAmount("1.2.3")).toBeNull();
    });

    it("returns null on integer overflow beyond MAX_SAFE_INTEGER", () => {
      expect(evalAmount("99999999999999999999999999999999")).toBeNull();
      expect(evalAmount("1e20 * 1e20")).toBeNull();
    });
  });

  describe("adjustDateShortcut", () => {
    it("handles +/- day shortcuts", () => {
      expect(adjustDateShortcut("2026-06-15", "+")).toBe("2026-06-16");
      expect(adjustDateShortcut("2026-06-15", "=")).toBe("2026-06-16");
      expect(adjustDateShortcut("2026-06-15", "-")).toBe("2026-06-14");
      expect(adjustDateShortcut("2026-06-15", "_")).toBe("2026-06-14");
    });

    it("handles month and year advance shortcuts", () => {
      expect(adjustDateShortcut("2026-06-15", "m")).toBe("2026-07-15");
      expect(adjustDateShortcut("2026-06-15", "M")).toBe("2026-07-15");
      expect(adjustDateShortcut("2026-06-15", "y")).toBe("2027-06-15");
      expect(adjustDateShortcut("2026-06-15", "Y")).toBe("2027-06-15");
    });

    it("handles today shortcut", () => {
      expect(adjustDateShortcut("2026-06-15", "t")).toBe(todayISO());
      expect(adjustDateShortcut("2026-06-15", "T")).toBe(todayISO());
    });

    it("returns null for unsupported keys or invalid dates", () => {
      expect(adjustDateShortcut("2026-06-15", "x")).toBeNull();
      expect(adjustDateShortcut("invalid", "+")).toBeNull();
    });
  });

  describe("round2 and previousMonthKey (UNI-40 / BUG-21, BUG-22, BUG-23, BUG-24)", () => {
    it("round2 rounds to 2 decimal places", () => {
      expect(round2(12.3456)).toBe(12.35);
      expect(round2(12.344)).toBe(12.34);
      expect(round2(100)).toBe(100);
    });

    it("previousMonthKey calculates preceding month key across year boundaries", () => {
      expect(previousMonthKey("2026-06")).toBe("2026-05");
      expect(previousMonthKey("2026-01")).toBe("2025-12");
      expect(prevMonthKey("2026-01")).toBe("2025-12");
    });
  });
});
