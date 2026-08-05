import { describe, expect, it } from "vitest";
import { evalAmount, fmt, fmtSigned, monthKey, monthLabel, nextDateFor, num, parseMonthKey, todayISO } from "../src/format.js";

describe("format", () => {
  it("fmt signs negative numbers", () => {
    expect(fmt(0)).toBe("$0.00");
    expect(fmt(123)).toBe("$123.00");
    expect(fmt(-123)).toBe("-$123.00");
    expect(fmt(1234.5)).toBe("$1,234.50");
  });

  it("fmt handles large numbers with comma separators", () => {
    expect(fmt(1234567.89)).toBe("$1,234,567.89");
    expect(fmt(-1234567.89)).toBe("-$1,234,567.89");
  });

  it("fmt rounds correctly at 2 decimal places", () => {
    expect(fmt(0.005)).toBe("$0.01"); // rounds up
    expect(fmt(0.004)).toBe("$0.00"); // rounds down
  });

  it("fmtSigned shows zero as $0.00", () => {
    expect(fmtSigned(0)).toBe("$0.00");
    expect(fmtSigned(-5)).toBe("-$5.00");
  });

  it("num parses strings and handles nullish/NaN", () => {
    expect(num("3.14")).toBeCloseTo(3.14);
    expect(num(7)).toBe(7);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num("not a number")).toBe(0);
  });

  it("num returns 0 for dollar-sign-prefixed strings (not a supported format)", () => {
    // "$1,234.56" is not parseable by parseFloat — callers should strip symbols first
    expect(num("$1,234.56")).toBe(0);
  });

  it("num handles negative strings", () => {
    expect(num("-42.50")).toBeCloseTo(-42.5);
    expect(num("-0")).toBeCloseTo(0); // parseFloat("-0") is IEEE -0, use toBeCloseTo
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
    // Simulating Dec 2025 + 1 → Jan 2026
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
      // Jan 31 + 1 month = Feb 28 (2026 is not a leap year)
      expect(nextDateFor("monthly", "2026-01-31")).toBe("2026-02-28");
    });

    it("advances yearly by one year", () => {
      expect(nextDateFor("yearly", "2026-07-01")).toBe("2027-07-01");
    });

    it("falls back to monthly for unknown frequencies", () => {
      expect(nextDateFor("every-fortnight-some-day", "2026-07-01")).toBe("2026-08-01");
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
});
});
