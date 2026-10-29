import { describe, expect, it } from "vitest";
import {
  niceTicks,
  symlogTicks,
  symlog,
  fmtShort,
  colorAt,
  colorForName,
  sankeyTargetColor,
  OTHER_BUCKET_COLOR,
  OVER_INCOME_COLOR,
  REMAINING_COLOR,
  PALETTE,
  computeOutlierBreak,
  iqrFence,
  niceScale,
  quantile,
  zigZagHorizontal,
  zigZagVertical,
} from "../src/chartUtils.js";

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

describe("quantile / iqrFence", () => {
  it("computes linear-interpolated quartiles", () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75);
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25);
  });

  it("returns 0 for empty input", () => {
    expect(quantile([], 0.5)).toBe(0);
  });

  it("flags values above Q3 + k*IQR as outliers", () => {
    const fence = iqrFence([48, 61, 39, 72, 55, 44, 67, 51, 940], 1.5);
    expect(fence.upper).toBeLessThan(940);
    expect(fence.upper).toBeGreaterThan(72);
  });
});

describe("niceScale", () => {
  it("returns a rounded top spanning the max", () => {
    const s = niceScale(1550, 3);
    expect(s.top).toBeGreaterThanOrEqual(1550);
    expect(s.ticks[s.ticks.length - 1]).toBe(s.top);
  });
});

describe("computeOutlierBreak", () => {
  it("returns NO_BREAK for fewer than 5 points", () => {
    expect(computeOutlierBreak([100, 5000]).hasBreak).toBe(false);
  });

  it("returns NO_BREAK for flat data", () => {
    expect(computeOutlierBreak([10, 10, 10, 10, 10]).hasBreak).toBe(false);
  });

  it("returns NO_BREAK when the tall bar is not a statistical outlier", () => {
    // 7 is within Q3 + 1.5*IQR of the rest.
    expect(computeOutlierBreak([2, 3, 4, 5, 7]).hasBreak).toBe(false);
  });

  it("detects an outlier and places the break above the tallest inlier", () => {
    const b = computeOutlierBreak([48, 61, 39, 72, 55, 44, 67, 51, 940]);
    expect(b.hasBreak).toBe(true);
    expect(b.breakTop).toBeGreaterThanOrEqual(72);
    expect(b.topVal).toBeGreaterThanOrEqual(940);
    expect(b.ticks.length).toBeGreaterThan(0);
  });

  it("keeps the compressed zone meaningful: topVal > breakTop * 1.1", () => {
    const b = computeOutlierBreak([48, 61, 39, 72, 55, 44, 67, 51, 940]);
    expect(b.topVal).toBeGreaterThan(b.breakTop * 1.1);
  });
});

describe("zigZag generators", () => {
  it("produce well-formed SVG path data", () => {
    const h = zigZagHorizontal(0, 100, 50);
    expect(h.startsWith("M 0 50")).toBe(true);
    expect(h).toContain("l ");
    const v = zigZagVertical(0, 100, 50);
    expect(v.startsWith("M 50 0")).toBe(true);
    expect(v).toContain("l ");
  });
});

describe("colorForName", () => {
  it("is deterministic: the same name always maps to the same palette color", () => {
    const a = colorForName("Groceries");
    expect(colorForName("Groceries")).toBe(a);
    expect(PALETTE).toContain(a);
  });

  it("spreads distinct names across the palette", () => {
    const names = ["Groceries", "Rent", "Fuel", "Fees", "Taxes", "Dining", "Travel"];
    const colors = new Set(names.map(colorForName));
    expect(colors.size).toBeGreaterThan(1);
  });

  it("hashes every name, including computed-row names: buckets resolve by flag, never by name", () => {
    // colorForName is a pure name hash (canonical in @ynab/logic): a literal
    // "Other" row keeps its own stable palette color instead of colliding
    // with the merged bucket's slate. Buckets and plugs resolve through
    // sankeyTargetColor by flag.
    expect(PALETTE).toContain(colorForName("Other"));
    expect(colorForName("Other")).not.toBe(OTHER_BUCKET_COLOR);
    expect(
      sankeyTargetColor({ name: "Other", bucket: true, isPlug: false })
    ).toBe(OTHER_BUCKET_COLOR);
  });

  it("renders Remaining and Over income rows by hash, plugs by flag", () => {
    expect(PALETTE).toContain(colorForName("Remaining"));
    expect(colorForName("Remaining")).not.toBe(REMAINING_COLOR);
    expect(PALETTE).toContain(colorForName("Over income"));
    expect(colorForName("Over income")).not.toBe(OVER_INCOME_COLOR);
    expect(
      sankeyTargetColor({ name: "Remaining", bucket: false, isPlug: true })
    ).toBe(REMAINING_COLOR);
  });
});
