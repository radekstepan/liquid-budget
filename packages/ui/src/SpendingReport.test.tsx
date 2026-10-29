"use client";

import { render } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SpendingGroupFlow } from "@ynab/logic";
import { SpendingReport } from "./SpendingReport.js";

// Thickness of a bar-to-bar ribbon path: ribbonPath emits
// `M x0 sy0 C ... x1 ty0 L x1 ty1 C ...`, so the target-edge run spans
// the band's drawn height.
function ribbonThickness(d: string): number {
  const tokens = d.trim().split(/\s+/);
  expect(tokens[0]).toBe("M");
  expect(tokens[3]).toBe("C");
  expect(tokens[10]).toBe("L");
  return Number(tokens[12]) - Number(tokens[9]);
}

describe("SpendingReport Sankey flow conservation", () => {
  const origWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const origHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

  beforeAll(() => {
    // jsdom reports zero sizes; give the chart a real layout box.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      value: 600,
    });
  });

  afterAll(() => {
    if (origWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", origWidth);
    if (origHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origHeight);
  });

  beforeEach(() => {
    // The Under auto-fit runs once per session; clear the flag so every
    // test starts from the stored threshold (localStorage is already
    // cleared by the shared setup).
    try {
      window.sessionStorage?.clear();
    } catch {}
  });

  it("matches each left-hop sub-ribbon to its right-hop ribbon per color when a minimum distorts a bar", () => {
    // One group feeding a huge target and a dust target: the dust bar is
    // lifted to the 24px label minimum (inflating its right ribbon past
    // its value share) while the huge bar donates height to fund it
    // (shrinking its right ribbon). The middle bar itself is NOT floored,
    // so the band keeps its full height and this pins the subdivision
    // weights alone: each color entering the middle must leave it at the
    // same thickness (task-43: Housing → Mortgage Interest vs its SAP
    // Concur sub-ribbon).
    const categoryFlow: SpendingGroupFlow = {
      groups: [{ name: "G", value: 10000 }],
      targets: [
        { name: "Big", value: 9900 },
        { name: "Small", value: 100 },
      ],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 9900 },
        { groupIndex: 0, targetIndex: 1, value: 100 },
      ],
    };
    const emptyFlow: SpendingGroupFlow = { groups: [], targets: [], links: [] };
    const { container } = render(
      <SpendingReport
        categoryFlow={categoryFlow}
        merchantFlow={emptyFlow}
        income={[{ name: "Pay", value: 10000 }]}
        initialView="sankey"
        initialDimension="categories"
      />
    );
    const svg = container.querySelector('[data-testid="sankey-svg"]');
    expect(svg).not.toBeNull();
    const paths = (side: string): Element[] =>
      Array.from(
        svg!.querySelectorAll(`path[data-testid="sankey-link"][data-side="${side}"]`)
      );
    const left = paths("left");
    const right = paths("right");
    // One income band subdivided into one sub-ribbon per downstream cell;
    // one ribbon per group→target cell.
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    // Same fill = same flow: total each color's thickness per hop and
    // require the middle column to conserve it.
    const sumByFill = (els: Element[]): Map<string, number> => {
      const sums = new Map<string, number>();
      for (const el of els) {
        const fill = el.getAttribute("fill") ?? "";
        const d = el.getAttribute("d") ?? "";
        sums.set(fill, (sums.get(fill) ?? 0) + ribbonThickness(d));
      }
      return sums;
    };
    const leftSums = sumByFill(left);
    const rightSums = sumByFill(right);
    expect(new Set(leftSums.keys())).toEqual(new Set(rightSums.keys()));
    for (const [fill, want] of rightSums) {
      expect(leftSums.get(fill)).toBeCloseTo(want, 1);
    }
  });
});
