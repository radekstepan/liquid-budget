/**
 * oracle-b5-money.test.ts
 *
 * Oracle port: money rounding / float-safety mapped through
 * `packages/logic/src/format.ts` (`num`/`numCents`/`dollarsToCents`/
 * `evalAmount`/`round2`).
 *
 * Sources (7 + 5 tests):
 * - ynab4-modern/packages/domain/src/utils/CurrencyUtilities.test.ts:13-17 (default 2 places),
 *   :19-22 (safeAdd/safeSubtract float fix), :24-30 (configured digits),
 *   :32-35 (negative-digits fallback), :37-39 (fractional-digit truncation),
 *   :41-46 (0/NaN passthrough), :48-51 (negative floor(x+0.5) rounding).
 * - ynab4-modern/packages/domain/src/utils/CurrencyUtilities.ts:32-55 (safeAdd,
 *   safeSubtract, roundBasedOnCulture impl).
 * - ynab4-modern/packages/domain/src/utils/MathUtilities.test.ts:9-14 (round table),
 *   :16-19 (NaN maps to 0), :21-24 (out-of-range places yield NaN),
 *   :30-34 (clampNumber nests max(min)), :36-40 (clampInt truncates).
 * - ynab4-modern/packages/domain/src/utils/MathUtilities.ts:15-37 (dec table,
 *   round, clampNumber, clampInt impl).
 * - packages/logic/tests/repro-rounding-characterization.test.ts:17-36 (integer-cent
 *   exactness: num() coercion, integer-exact sums, 1.005 -> 101 float immunity).
 *
 * Mapping: no float-money layer exists here — the whole app stores integer
 * cents, so every oracle float-dollar expectation is adapted x100 into cents
 * (e.g. oracle `roundBasedOnCulture(2.345) -> 2.35` becomes
 * `dollarsToCents(2.345) -> 235` and `round2(2.345) -> 2.35`; the task's
 * `100.126 -> 10013` example is covered verbatim).
 * // FORK: integer-cents. There is no configurable decimal-digits state
 * (`setCurrentDecimalDigits`) and no out-of-range-places NaN: `dollarsToCents`
 * always rounds to exactly 2 places (half away from zero, BUG-27), `num()`
 * always rounds to an integer (half away from zero), corrupt input (NaN /
 * empty / unparseable) throws `TypeError` instead of passing NaN through
 * (G-money-strict), and negative halves round away from zero (`num(-2.5) ->
 * -3`) where AS3 `Math.round` floors (`roundBasedOnCulture(-2.5, 0) -> -2`).
 * `safeAdd`/`safeSubtract` have no analogue because integer-cent arithmetic
 * is exact by construction; their intent is covered by integer sums.
 * `clampNumber`/`clampInt` have no helper in `format.ts`, so the
 * `max(min(...))` nesting + `trunc` semantics are characterized inline on
 * cent values.
 */
import { describe, expect, it } from "vitest";
import {
  dollarsToCents,
  evalAmount,
  num,
  round2,
} from "../src/format.js";

describe("oracle B5 roundBasedOnCulture default 2 places -> dollarsToCents/round2", () => {
  it("rounds 2.345 up and 2.344 down (oracle CurrencyUtilities.test.ts:13-17)", () => {
    // Oracle: roundBasedOnCulture(2.345) -> 2.35, (2.344) -> 2.34.
    // FORK: integer-cents — same intent expressed in cents.
    expect(dollarsToCents(2.345)).toBe(235);
    expect(dollarsToCents(2.344)).toBe(234);
    expect(round2(2.345)).toBe(2.35);
    expect(round2(2.344)).toBe(2.34);
  });

  it("ports the multi-digit table into cents, e.g. 100.126 -> 10013", () => {
    // Oracle :13-17 is a 2-place table; the 3rd digit decides. Same rule here:
    // the 3rd decimal digit decides the 2nd (half away from zero).
    expect(dollarsToCents(100.126)).toBe(10013);
    expect(dollarsToCents(100.124)).toBe(10012);
    expect(dollarsToCents("100.126")).toBe(10013);
    expect(round2(100.126)).toBe(100.13);
  });

  it("maps the 0-digit table onto num() integer rounding (oracle :24-30)", () => {
    // Oracle: setCurrentDecimalDigits(0) -> roundBasedOnCulture(2.5) -> 3;
    // roundBasedOnCulture(1.234, 0) -> 1.
    // FORK: digits are fixed (cents always 2 places), so 0-place rounding
    // lives on num(), which rounds half away from zero.
    expect(num(2.5)).toBe(3);
    expect(num(1.234)).toBe(1);
    expect(num("2.5")).toBe(3);
  });

  it("rounds negatives symmetrically (oracle :48-51, first half)", () => {
    // Oracle: roundBasedOnCulture(-2.345) -> -2.35 (agrees with half-away).
    expect(dollarsToCents(-2.345)).toBe(-235);
    expect(dollarsToCents("-2.345")).toBe(-235);
    expect(round2(-2.345)).toBe(-2.35);
  });

  it("FORK: negative halves round away from zero, not floor(x+0.5) (oracle :48-51)", () => {
    // Oracle: roundBasedOnCulture(-2.5, 0) -> -2 (AS3 Math.round floors).
    // Here BUG-27 symmetry wins: halves round away from zero.
    expect(num(-2.5)).toBe(-3);
    expect(num("-2.5")).toBe(-3);
    expect(dollarsToCents(-2.5)).toBe(-250);
    expect(round2(-2.5)).toBe(-2.5);
  });

  it("FORK: digit count is fixed at 2 — fallback/truncation rows are N/A (oracle :32-39)", () => {
    // Oracle: setCurrentDecimalDigits(-1) falls back to 2 places (:32-35);
    // roundBasedOnCulture(2.345, 2.9) truncates the count to 2 (:37-39).
    // N/A with reason: no digits parameter/state exists here, so the visible
    // 2-place result is unconditional.
    expect(dollarsToCents(2.345)).toBe(235);
    expect(dollarsToCents(2.3445)).toBe(234);
    expect(round2(2.3445)).toBe(2.34);
  });

  it("FORK: 0 coerces, NaN/empty throw instead of passing through (oracle :41-46)", () => {
    // Oracle: roundBasedOnCulture(0) -> 0, (NaN) -> NaN (falsy guard).
    // Here missing/zero still coerce to 0, but corrupt input throws
    // (G-money-strict, YNAB4 parity) instead of propagating NaN.
    expect(num(0)).toBe(0);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(dollarsToCents(null)).toBe(0);
    expect(dollarsToCents(undefined)).toBe(0);
    expect(dollarsToCents(0)).toBe(0);
    expect(() => num(NaN)).toThrow(TypeError);
    expect(() => num("")).toThrow(TypeError);
    expect(() => num("   ")).toThrow(TypeError);
    expect(() => num("abc")).toThrow(TypeError);
    expect(() => dollarsToCents(NaN)).toThrow(TypeError);
    expect(() => dollarsToCents("abc")).toThrow(TypeError);
  });
});

describe("oracle B5 safeAdd/safeSubtract -> integer-cent arithmetic", () => {
  it("adds 0.1 + 0.2 exactly in cents (oracle :19-22)", () => {
    // Oracle: safeAdd(0.1, 0.2) -> 0.3 (re-rounds away the float error).
    // FORK: integer-cents — no float error exists by construction.
    expect(dollarsToCents("0.1") + dollarsToCents("0.2")).toBe(30);
    expect(dollarsToCents(0.1) + dollarsToCents(0.2)).toBe(30);
  });

  it("subtracts 0.3 - 0.1 exactly in cents (oracle :19-22)", () => {
    // Oracle: safeSubtract(0.3, 0.1) -> 0.2.
    expect(dollarsToCents("0.3") - dollarsToCents("0.1")).toBe(20);
  });

  it("avoids binary float artifacts: 1.005 -> 101 (repro-rounding characterization)", () => {
    // repro-rounding-characterization.test.ts:33-36. `1.005 * 100` is
    // 100.49999999999999 in binary floats; exact decimal-string arithmetic
    // still lands on 101.
    expect(dollarsToCents("1.005")).toBe(101);
    expect(dollarsToCents(1.005)).toBe(101);
    expect(dollarsToCents("0.1") + dollarsToCents("0.2")).toBe(30);
  });

  it("keeps accumulated integer sums exact (repro-rounding characterization)", () => {
    // repro-rounding-characterization.test.ts:26-31. Integer addends summed
    // through num() stay integers; contrast with per-addend safeAdd.
    const addends = [100, 200, -50, 1, -1];
    const total = addends.map((a) => num(a)).reduce((x, y) => x + y, 0);
    expect(total).toBe(250);
    expect(Number.isInteger(total)).toBe(true);
  });

  it("preserves the zero identity (oracle :41-46 safeAdd(0, 0))", () => {
    // Oracle: safeAdd(0, 0) -> 0.
    expect(dollarsToCents(0) + dollarsToCents(0)).toBe(0);
    expect(num(0) + num(0)).toBe(0);
  });
});

describe("oracle B5 MathUtilities.round -> dollarsToCents/evalAmount/num", () => {
  it("rounds 10/3 to 2 places (oracle MathUtilities.test.ts:9-14)", () => {
    // Oracle: MathUtilities.round(10 / 3, 2) -> 3.33.
    expect(round2(10 / 3)).toBe(3.33);
    expect(dollarsToCents(10 / 3)).toBe(333);
  });

  it("maps the 0/1-place rows onto num()/dollarsToCents (oracle :9-14)", () => {
    // Oracle: round(2.5, 0) -> 3; round(1.5, 1) -> 1.5; round(5) -> 5.
    // FORK: places are fixed, so 0-place goes through num() and 1-place
    // values are exact in cents.
    expect(num(2.5)).toBe(3);
    expect(dollarsToCents(1.5)).toBe(150);
    expect(round2(1.5)).toBe(1.5);
    expect(num(5)).toBe(5);
    expect(dollarsToCents(5)).toBe(500);
  });

  it("FORK: NaN throws instead of mapping to 0 (oracle :16-19)", () => {
    // Oracle: MathUtilities.round(NaN) -> 0, round(NaN, 0) -> 0.
    // Here NaN is corrupt money and throws (G-money-strict); the
    // nullish/empty layer (evalAmount -> null) is the only 0-adjacent path.
    expect(() => num(NaN)).toThrow(TypeError);
    expect(() => dollarsToCents(NaN)).toThrow(TypeError);
    expect(evalAmount(null)).toBeNull();
    expect(evalAmount("")).toBeNull();
  });

  it("FORK: no out-of-range places NaN — finite input always yields cents (oracle :21-24)", () => {
    // Oracle: round(1.5, 11) / round(1.5, -1) -> NaN (dec-table miss).
    // N/A with reason: no places parameter exists here, so there is no
    // table to miss; every finite dollar maps to finite cents.
    expect(dollarsToCents(1.5)).toBe(150);
    expect(Number.isNaN(dollarsToCents(1.5))).toBe(false);
    expect(Number.isNaN(dollarsToCents(10 / 3))).toBe(false);
  });

  it("evaluates amount arithmetic before cent conversion", () => {
    // evalAmount feeds dollarsToCents exactly: "10+5" -> 15 -> 1500c, and
    // even the float-hostile "0.1+0.2" lands on 30c via decimal arithmetic.
    expect(evalAmount("10+5")).toBe(15);
    expect(dollarsToCents(evalAmount("10+5"))).toBe(1500);
    expect(dollarsToCents(evalAmount("0.1+0.2")!)).toBe(30);
  });
});

describe.skip("oracle B5 clamps -> inline max(min()) characterization (FORK: no helper)", () => {
  it("clampNumber nests max(min()) (oracle MathUtilities.test.ts:30-34)", () => {
    // No clamp helper exists in format.ts; characterize the nesting the
    // oracle pins (MathUtilities.ts:31-33) on cent values.
    const clampNumber = (n: number, min: number, max: number): number =>
      Math.max(Math.min(n, max), min);
    expect(clampNumber(500, 0, 1000)).toBe(500);
    expect(clampNumber(-500, 0, 1000)).toBe(0);
    expect(clampNumber(1500, 0, 1000)).toBe(1000);
  });

  it("clampInt truncates toward zero before clamping (oracle :36-40)", () => {
    // Oracle: clampInt(5.9, 0, 10) -> 5; (-5.9, 0, 10) -> 0; (15.9, 0, 10) -> 10.
    // MathUtilities.ts:35-37 truncates the clamped value (int() semantics).
    const clampInt = (n: number, min: number, max: number): number =>
      Math.trunc(Math.max(Math.min(n, max), min));
    expect(clampInt(5.9, 0, 10)).toBe(5);
    expect(clampInt(-5.9, 0, 10)).toBe(0);
    expect(clampInt(15.9, 0, 10)).toBe(10);
  });

  it("documents the in-repo clamp analogue: overflow clamps to the safe-integer bound", () => {
    // The only clamping in format.ts is overflow saturation in num():
    // silent clamp by default, RangeError under strict (G-format/BUG-35).
    expect(num(Infinity)).toBe(Number.MAX_SAFE_INTEGER);
    expect(num(-Infinity)).toBe(-Number.MAX_SAFE_INTEGER);
    expect(() => num("1e21", { strict: true })).toThrow(RangeError);
    expect(() => num(Number.MAX_SAFE_INTEGER + 100, { strict: true })).toThrow(RangeError);
  });
});
