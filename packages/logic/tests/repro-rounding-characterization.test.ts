import { describe, expect, it } from "vitest";
import { dollarsToCents, num } from "../src/format.js";

/**
 * Characterization (must PASS — documents no-divergence): totals over
 * integer cents are exact. `num()` coerces every addend to an integer via
 * `Math.round` (format.ts:88,132) and `dollarsToCents` uses exact
 * decimal-string arithmetic, so binary float artifacts (e.g. 1.005 * 100)
 * cannot shift a total by a cent. Contrast with YNAB4's per-addend `safeAdd`;
 * on integer-cent inputs both approaches agree exactly.
 *
 * Regression note: corrupt addends throw (fix commit a3a050d, g-money-strict;
 * YNAB4 parity — see repro-money-nan.test.ts), so a corrupt addend can never
 * silently poison a total.
 */
describe("characterization: totals over integer cents are exact (no divergence)", () => {
  it("num() coerces every addend to an integer", () => {
    expect(num("10.5")).toBe(11);
    expect(num(10.4)).toBe(10);
    // G-money-strict: corrupt addends throw instead of silently
    // coercing to 0 (YNAB4 parity — see repro-money-nan.test.ts),
    // so a corrupt addend can never silently poison a total.
    expect(() => num("abc")).toThrow(TypeError);
  });

  it("accumulated sums stay integer-exact", () => {
    const addends = [100, 200, -50, 1, -1];
    const total = addends.map((a) => num(a)).reduce((x, y) => x + y, 0);
    expect(total).toBe(250);
    expect(Number.isInteger(total)).toBe(true);
  });

  it("dollarsToCents avoids binary float artifacts (1.005 -> 101, 0.1 + 0.2 -> 30)", () => {
    expect(dollarsToCents("1.005")).toBe(101);
    expect(dollarsToCents("0.1") + dollarsToCents("0.2")).toBe(30);
  });
});
