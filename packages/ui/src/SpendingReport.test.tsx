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

  it("enters the middle as one contiguous block per color at the outgoing cell's thickness", () => {
    // Two incomes funding one group with two cells: every income's slice of
    // a cell must land ADJACENT to the other income's slice of the same
    // cell, so each color crosses the middle as ONE contiguous block at
    // exactly the thickness its cell leaves it. Band-local subdivision
    // (each income's slice buried inside its own band) renders the same
    // color thinner on the way in than on the way out (task-44: SAP Concur
    // → Housing vs Housing → Mortgage Interest).
    const categoryFlow: SpendingGroupFlow = {
      groups: [{ name: "Housing", value: 10000 }],
      targets: [
        { name: "Mortgage Interest", value: 7000 },
        { name: "Closing Costs", value: 3000 },
      ],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 7000 },
        { groupIndex: 0, targetIndex: 1, value: 3000 },
      ],
    };
    const emptyFlow: SpendingGroupFlow = { groups: [], targets: [], links: [] };
    const { container } = render(
      <SpendingReport
        categoryFlow={categoryFlow}
        merchantFlow={emptyFlow}
        income={[
          { name: "SAP Concur", value: 6000 },
          { name: "Payroll", value: 4000 },
        ]}
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
    // Two bands subdivided into two sub-ribbons each; one ribbon per cell.
    expect(left).toHaveLength(4);
    expect(right).toHaveLength(2);
    // Target-edge slot of a bar-to-bar ribbon path: ribbonPath emits
    // `M x0 sy0 C ... x1 ty0 L x1 ty1 C ...`, so tokens 9/12 span the slot.
    const targetSlot = (d: string): [number, number] => {
      const tokens = d.trim().split(/\s+/);
      expect(tokens[0]).toBe("M");
      expect(tokens[3]).toBe("C");
      expect(tokens[10]).toBe("L");
      return [Number(tokens[9]), Number(tokens[12])];
    };
    const byFill = new Map<string, [number, number][]>();
    for (const el of left) {
      const fill = el.getAttribute("fill") ?? "";
      const slot = targetSlot(el.getAttribute("d") ?? "");
      const slots = byFill.get(fill) ?? [];
      slots.push(slot);
      byFill.set(fill, slots);
    }
    expect(byFill.size).toBe(2);
    for (const [fill, slots] of byFill) {
      // Same-color slots land adjacent: one contiguous block per color.
      slots.sort((a, b) => a[0] - b[0]);
      for (let k = 1; k < slots.length; k++) {
        expect(slots[k]![0]).toBeCloseTo(slots[k - 1]![1], 1);
      }
      const blockH = slots[slots.length - 1]![1] - slots[0]![0];
      // ... at exactly the thickness the cell leaves the middle.
      const cell = right.find((el) => el.getAttribute("fill") === fill);
      expect(cell).toBeDefined();
      expect(blockH).toBeCloseTo(ribbonThickness(cell!.getAttribute("d") ?? ""), 1);
    }
  });
});
