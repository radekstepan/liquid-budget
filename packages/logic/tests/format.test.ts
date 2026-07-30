import { describe, expect, it } from "vitest";
import { fmt, fmtSigned, monthKey, monthLabel, num, parseMonthKey, todayISO } from "../src/format.js";

describe("format", () => {
  it("fmt signs negative numbers", () => {
    expect(fmt(0)).toBe("$0.00");
    expect(fmt(123)).toBe("$123.00");
    expect(fmt(-123)).toBe("-$123.00");
    expect(fmt(1234.5)).toBe("$1,234.50");
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

  it("monthLabel renders long month + year", () => {
    expect(monthLabel("2025-07")).toBe("July 2025");
    expect(monthLabel("2024-01")).toBe("January 2024");
  });

  it("todayISO returns YYYY-MM-DD", () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
