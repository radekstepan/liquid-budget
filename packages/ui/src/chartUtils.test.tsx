import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import {
  colorForName,
  computeOutlierBreak,
  iqrFence,
  niceCeil,
  NO_BREAK,
  OTHER_BUCKET_COLOR,
  quantile,
  REMAINING_COLOR,
  sankeyFamilyShade,
  sankeyIncomeGradientStops,
  sankeyTargetColors,
  SANKEY_INCOME_COLOR,
  shade,
  useElementSize,
} from "./chartUtils.js";

describe("quantile", () => {
  it("returns 0 for an empty array", () => {
    expect(quantile([], 0.5)).toBe(0);
  });

  it("interpolates linearly between sorted values", () => {
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(quantile([10, 20, 30, 40], 0)).toBe(10);
    expect(quantile([10, 20, 30, 40], 1)).toBe(40);
  });
});

describe("iqrFence", () => {
  it("computes the Tukey upper fence", () => {
    const fence = iqrFence([100, 110, 105, 95, 102, 98]);
    expect(fence.iqr).toBeGreaterThan(0);
    expect(fence.upper).toBe(fence.q3 + 1.5 * fence.iqr);
    expect(fence.upper).toBeGreaterThan(110);
  });
});

describe("niceCeil", () => {
  it("rounds up to 1/2/2.5/5 x 10^k", () => {
    expect(niceCeil(4300)).toBe(5000);
    expect(niceCeil(2000)).toBe(2000);
    expect(niceCeil(0)).toBe(1);
  });
});

describe("computeOutlierBreak", () => {
  it("returns NO_BREAK with fewer than 5 positive points", () => {
    expect(computeOutlierBreak([100, 100, 100, 100000])).toBe(NO_BREAK);
  });

  it("returns NO_BREAK when months are evenly distributed", () => {
    expect(computeOutlierBreak([100, 110, 105, 95, 102, 98])).toBe(NO_BREAK);
  });

  it("returns NO_BREAK when the tallest bar is only slightly above the rest", () => {
    // 130 sits above the fence but within minGap (1.4x) of the max inlier.
    expect(computeOutlierBreak([100, 102, 104, 106, 108, 130])).toBe(NO_BREAK);
  });

  it("detects a huge one-off month and caps the axis above the inliers", () => {
    const values = [10000, 11000, 10500, 9500, 10200, 9800, 500000];
    const result = computeOutlierBreak(values);
    expect(result.hasBreak).toBe(true);
    expect(result.outlierIdx).toEqual([6]);
    // The break sits just above the inlier band, far below the outlier.
    expect(result.breakTop).toBeLessThan(500000);
    expect(result.breakTop).toBeGreaterThanOrEqual(11000);
    // The compressed zone still reaches the outlier.
    expect(result.topVal).toBeGreaterThanOrEqual(500000);
    expect(result.ticks.length).toBeGreaterThan(0);
  });

  it("ignores non-positive values", () => {
    expect(computeOutlierBreak([0, -5, 100, 100, 100, 100, 100])).toBe(NO_BREAK);
  });
});

describe("sankeyFamilyShade", () => {
  it("keeps the parent color exactly at rank 0", () => {
    expect(sankeyFamilyShade("#2f7fb0", 0)).toBe("#2f7fb0");
    expect(sankeyFamilyShade("#2f7fb0", -1)).toBe("#2f7fb0");
  });

  it("darkens by rank without brightening any channel", () => {
    const base = "#2f7fb0";
    const shades = [1, 2, 3, 4, 5, 6, 10].map((r) => sankeyFamilyShade(base, r));
    expect(shades[0]).toBe(shade(base, 0.87));
    for (const out of shades) {
      expect(out).toMatch(/^#[0-9a-f]{6}$/);
      for (let i = 0; i < 3; i++) {
        const inp = parseInt(base.slice(1 + i * 2, 3 + i * 2), 16);
        const got = parseInt(out.slice(1 + i * 2, 3 + i * 2), 16);
        expect(got).toBeLessThanOrEqual(inp);
      }
    }
    // Monotonic: each deeper rank is no brighter than the last.
    const lum = (hex: string) =>
      [0, 1, 2].reduce((s, i) => s + parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16), 0);
    for (let i = 1; i < shades.length; i++) {
      expect(lum(shades[i]!)).toBeLessThanOrEqual(lum(shades[i - 1]!));
    }
  });
});

describe("sankeyTargetColors", () => {
  const groups = [
    { name: "Bills", bucket: false },
    { name: "Everyday", bucket: false },
  ];
  const bills = colorForName("Bills");
  const everyday = colorForName("Everyday");

  it("colors each target as a shade of its parent group", () => {
    const colors = sankeyTargetColors(
      groups,
      [
        { name: "Mortgage Interest", bucket: false, isPlug: false },
        { name: "Groceries", bucket: false, isPlug: false },
        { name: "Electric Bill", bucket: false, isPlug: false },
      ],
      [
        { middleIndex: 0, targetIndex: 0, value: 100000 },
        { middleIndex: 0, targetIndex: 2, value: 15000 },
        { middleIndex: 1, targetIndex: 1, value: 40000 },
      ]
    );
    // Darkest-first: the first (largest, in Amount sort) sibling takes the
    // darkest shade and later siblings lighten toward the parent color, so
    // more money reads darker; single children keep the parent color.
    expect(colors).toEqual([
      sankeyFamilyShade(bills, 1),
      everyday,
      bills,
    ]);
  });

  it("reads more money as a darker color within a family", () => {
    const colors = sankeyTargetColors(
      groups,
      [
        { name: "Big", bucket: false, isPlug: false },
        { name: "Mid", bucket: false, isPlug: false },
        { name: "Small", bucket: false, isPlug: false },
      ],
      [
        { middleIndex: 0, targetIndex: 0, value: 900 },
        { middleIndex: 0, targetIndex: 1, value: 500 },
        { middleIndex: 0, targetIndex: 2, value: 100 },
      ]
    );
    // Amount sort runs largest-first down the column: luminance must rise
    // down the column — the largest sibling is the darkest.
    const lum = (hex: string) =>
      [0, 1, 2].reduce((s, i) => s + parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16), 0);
    expect(lum(colors[0]!)).toBeLessThan(lum(colors[1]!));
    expect(lum(colors[1]!)).toBeLessThan(lum(colors[2]!));
    expect(colors[2]).toBe(bills);
  });

  it("attributes a multi-group target to its dominant group", () => {
    const colors = sankeyTargetColors(
      groups,
      [{ name: "Amazon", bucket: false, isPlug: false }],
      [
        { middleIndex: 0, targetIndex: 0, value: 100 },
        { middleIndex: 1, targetIndex: 0, value: 900 },
      ]
    );
    expect(colors).toEqual([everyday]);
  });

  it("keeps the Remaining plug green and Other buckets slate by flag, never by name", () => {
    const colors = sankeyTargetColors(
      groups,
      [
        // A literal "Remaining" category joins its own family.
        { name: "Remaining", bucket: false, isPlug: false },
        // A literal "Other" merchant joins its own family.
        { name: "Other", bucket: false, isPlug: false },
        { name: "Other", bucket: true, isPlug: false },
        { name: "Remaining", bucket: false, isPlug: true },
      ],
      [
        { middleIndex: 0, targetIndex: 0, value: 10 },
        { middleIndex: 0, targetIndex: 1, value: 5 },
        { middleIndex: 0, targetIndex: 2, value: 3 },
      ]
    );
    expect(colors[0]).toBe(sankeyFamilyShade(bills, 1));
    expect(colors[1]).toBe(bills);
    expect(colors[2]).toBe(OTHER_BUCKET_COLOR);
    expect(colors[3]).toBe(REMAINING_COLOR);
  });

  it("shades targets routed through the merged Other group in slate", () => {
    const colors = sankeyTargetColors(
      [{ name: "Other", bucket: true }],
      [{ name: "Kept Category", bucket: false, isPlug: false }],
      [{ middleIndex: 0, targetIndex: 0, value: 100 }]
    );
    expect(colors).toEqual([OTHER_BUCKET_COLOR]);
  });

  it("falls back to the stable name color for targets with no incoming link", () => {
    const colors = sankeyTargetColors(
      groups,
      [{ name: "Orphan", bucket: false, isPlug: false }],
      []
    );
    expect(colors).toEqual([colorForName("Orphan")]);
  });
});

describe("useElementSize", () => {
  const origRO = globalThis.ResizeObserver;
  const origWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const origHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

  afterEach(() => {
    globalThis.ResizeObserver = origRO;
    if (origWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", origWidth);
    if (origHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origHeight);
  });

  it("commits a new size only when the measured box actually changes", () => {
    // The observer delivers duplicate notifications (the ref-attach update
    // races the observer's initial notification, and scrollbars settling can
    // re-fire with identical dimensions). Each duplicate used to setState a
    // fresh object, forcing a full chart re-render and layout recompute per
    // notification — visible jitter on open. Same-size notifications must be
    // dropped; real resizes still commit.
    let box = { width: 800, height: 400 };
    // jsdom reports zero sizes; give the measured box a real layout box.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => box.width,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => box.height,
    });
    let notify: (() => void) | null = null;
    class CaptureRO {
      constructor(cb: () => void) {
        notify = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = CaptureRO as unknown as typeof ResizeObserver;

    let renders = 0;
    function Probe() {
      const { ref, size } = useElementSize<HTMLDivElement>();
      renders++;
      return <div ref={ref} data-w={size.width} data-h={size.height} />;
    }
    const { container } = render(<Probe />);
    expect(notify).not.toBeNull();
    const settledRenders = renders;
    expect(container.firstElementChild!.getAttribute("data-w")).toBe("800");

    // Duplicate notifications with an unchanged box: no re-render.
    act(() => {
      notify!();
    });
    act(() => {
      notify!();
    });
    expect(renders).toBe(settledRenders);

    // A real resize still commits.
    box = { width: 1024, height: 400 };
    act(() => {
      notify!();
    });
    expect(renders).toBe(settledRenders + 1);
    expect(container.firstElementChild!.getAttribute("data-w")).toBe("1024");
  });
});

describe("sankeyIncomeGradientStops", () => {
  it("stacks band colors top-to-bottom with hard edges on the ribbon boundaries", () => {
    const stops = sankeyIncomeGradientStops(100, 300, [
      { y0: 100, y1: 160, color: "#aaaaaa" },
      { y0: 160, y1: 240, color: "#bbbbbb" },
      { y0: 240, y1: 300, color: "#cccccc" },
    ]);
    // Each band keeps its ribbon's color through its exact span; adjacent
    // bands share their boundary offset, which renders the hard edge — so
    // every bar segment matches the ribbon leaving it.
    const o = (y: number) => (y - 100) / 200;
    expect(stops).toEqual([
      { offset: 0, color: "#aaaaaa" },
      { offset: o(160), color: "#aaaaaa" },
      { offset: o(160), color: "#bbbbbb" },
      { offset: o(240), color: "#bbbbbb" },
      { offset: o(240), color: "#cccccc" },
      { offset: 1, color: "#cccccc" },
    ]);
    // Ascending within [0, 1].
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]!.offset).toBeGreaterThanOrEqual(stops[i - 1]!.offset);
      expect(stops[i]!.offset).toBeLessThanOrEqual(1);
      expect(stops[i]!.offset).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps every band's color in order without collapsing neighbors", () => {
    const stops = sankeyIncomeGradientStops(0, 100, [
      { y0: 0, y1: 50, color: "#111111" },
      { y0: 50, y1: 100, color: "#222222" },
    ]);
    expect(stops.map((s) => s.color)).toEqual(["#111111", "#111111", "#222222", "#222222"]);
    expect(stops.map((s) => s.offset)).toEqual([0, 0.5, 0.5, 1]);
  });

  it("renders a solid fill for a single band and skips zero-height bands", () => {
    expect(
      sankeyIncomeGradientStops(0, 100, [{ y0: 0, y1: 100, color: "#123456" }])
    ).toEqual([
      { offset: 0, color: "#123456" },
      { offset: 1, color: "#123456" },
    ]);
    // The zero-height band drops out; its neighbors meet at a hard edge.
    const stops = sankeyIncomeGradientStops(0, 100, [
      { y0: 0, y1: 50, color: "#111111" },
      { y0: 50, y1: 50, color: "#999999" },
      { y0: 50, y1: 100, color: "#222222" },
    ]);
    expect(stops).toEqual([
      { offset: 0, color: "#111111" },
      { offset: 0.5, color: "#111111" },
      { offset: 0.5, color: "#222222" },
      { offset: 1, color: "#222222" },
    ]);
  });

  it("falls back to the neutral income gray with no bands", () => {
    expect(sankeyIncomeGradientStops(0, 100, [])).toEqual([
      { offset: 0, color: SANKEY_INCOME_COLOR },
      { offset: 1, color: SANKEY_INCOME_COLOR },
    ]);
  });
});
