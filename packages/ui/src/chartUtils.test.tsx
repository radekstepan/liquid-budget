import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import {
  computeOutlierBreak,
  iqrFence,
  niceCeil,
  NO_BREAK,
  quantile,
  sankeyRibbonShade,
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

describe("sankeyRibbonShade", () => {
  it("derives a darker shade of the same hue", () => {
    expect(sankeyRibbonShade("#2f7fb0")).toBe("#1a4661");
  });

  it("never brightens a channel and keeps valid hex", () => {
    for (const hex of ["#e8a33d", "#8bc34a", "#78909c", "#ffffff"]) {
      const out = sankeyRibbonShade(hex);
      expect(out).toMatch(/^#[0-9a-f]{6}$/);
      for (let i = 0; i < 3; i++) {
        const inp = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
        const got = parseInt(out.slice(1 + i * 2, 3 + i * 2), 16);
        expect(got).toBeLessThanOrEqual(inp);
      }
    }
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
