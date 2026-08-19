import { describe, expect, it } from "vitest";
import { niceTicks, symlogTicks, symlog, fmtShort, colorAt } from "../src/chartUtils.js";

describe("niceTicks", () => {
  it("always spans min and max (tMin <= min and tMax >= max)", () => {
    const testCases: [number, number][] = [
      [0, 95000],
      [0, 135000],
      [-35000, 95000],
      [-12000, 50000],
      [100, 500],
      [0, 1],
      [-500, 0],
      [-1000000, 2500000],
      [42, 42],
    ];

    for (const [min, max] of testCases) {
      const ticks = niceTicks(min, max, 5);
      expect(ticks.length).toBeGreaterThanOrEqual(1);
      const tMin = ticks[0]!;
      const tMax = ticks[ticks.length - 1]!;
      expect(tMin).toBeLessThanOrEqual(min);
      expect(tMax).toBeGreaterThanOrEqual(max);
    }
  });

  it("handles when min equals max", () => {
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    const ticks = niceTicks(500, 500);
    expect(ticks[0]).toBeLessThanOrEqual(500);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(500);
  });

  it("generates monotonically increasing ticks with uniform steps", () => {
    const ticks = niceTicks(0, 95000, 5);
    expect(ticks).toEqual([0, 20000, 40000, 60000, 80000, 100000]);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
    }
  });
});

describe("symlogTicks", () => {
  it("covers positive and negative domains completely", () => {
    const testCases: [number, number][] = [
      [-30000000, 50000000],
      [-500, 800],
      [0, 50000],
      [-25000, 0],
      [0, 50],
    ];

    for (const [minVal, maxVal] of testCases) {
      const ticks = symlogTicks(minVal, maxVal);
      expect(ticks.includes(0)).toBe(true);
      if (minVal < 0) {
        expect(ticks[0]).toBeLessThanOrEqual(minVal);
      }
      if (maxVal > 0) {
        expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(maxVal);
      }
    }
  });
});

describe("symlog", () => {
  it("computes symmetric log values correctly", () => {
    expect(symlog(0)).toBe(0);
    expect(symlog(99)).toBeCloseTo(2);
    expect(symlog(-99)).toBeCloseTo(-2);
  });
});

describe("fmtShort", () => {
  it("formats cents in human-readable short currency format", () => {
    expect(fmtShort(100_000_000)).toBe("$1M");
    expect(fmtShort(50_000_000)).toBe("$500K");
    expect(fmtShort(10_000_00)).toBe("$10K");
    expect(fmtShort(-100_000_000)).toBe("-$1M");
  });
});

describe("colorAt", () => {
  it("provides distinct contrasting colors for sequential categories", () => {
    const top3 = [colorAt(0), colorAt(1), colorAt(2)];
    // Ensure all 3 top categories have distinct colors (Blue, Green, Amber)
    expect(new Set(top3).size).toBe(3);
    expect(top3[0]).toBe("#2f7fb0"); // Steel Blue
    expect(top3[1]).toBe("#5c8f2c"); // Forest Green
    expect(top3[2]).toBe("#e8a33d"); // Amber/Gold
  });
});
