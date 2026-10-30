import { describe, expect, it } from "vitest";
import {
  colorForName,
  layoutGroupedIncomeSankey,
  mergeBelowThreshold,
  mergeGroupFlow,
  REMAINING_COLOR,
  SANKEY_NODE_GAP,
  SANKEY_PAD_BOTTOM,
  SANKEY_PAD_TOP,
  SANKEY_SOURCE_GUTTER,
  type MergedSpendingItem,
  type SpendingBreakdownItem,
  type SpendingGroupFlowLink,
} from "../src/sankey.js";

const item = (name: string, value: number): SpendingBreakdownItem => ({ name, value });
const merged = (name: string, value: number): MergedSpendingItem => ({
  name,
  value,
  mergedCount: 1,
});

/**
 * Categories golden image (task-46): the Categories Sankey view is the
 * reference rendering, so this locks its full layout output — every node,
 * ribbon, sub-ribbon, gradient stop, fill, and label anchor — as a
 * committed JSON snapshot plus explicit through-color pins. Any geometry or
 * color regression in the Categories grouping fails here first.
 *
 * The fixture mirrors the SpendingReport Categories sample (two groups,
 * three categories, one income with a Remaining surplus, no merge): the
 * same flow the view lays out with leftDetail "cells".
 */
function goldenCategoriesLayout() {
  const groups = [item("Bills", 115000), item("Everyday", 40000)];
  const targets = [
    item("Mortgage Interest", 100000),
    item("Groceries", 40000),
    item("Electric Bill", 15000),
  ];
  const links: SpendingGroupFlowLink[] = [
    { groupIndex: 0, targetIndex: 0, value: 100000 },
    { groupIndex: 0, targetIndex: 2, value: 15000 },
    { groupIndex: 1, targetIndex: 1, value: 40000 },
  ];
  const income = [item("Payroll", 200000)];
  const mergedFlow = mergeGroupFlow(groups, targets, links, 0);
  const mergedIncome = mergeBelowThreshold(income, 0);
  return layoutGroupedIncomeSankey(
    mergedIncome.items,
    mergedFlow.groups,
    mergedFlow.targets,
    mergedFlow.links,
    {
      width: 800,
      height: 400,
      padLeft: SANKEY_SOURCE_GUTTER,
      padRight: 190,
      padTop: SANKEY_PAD_TOP,
      padBottom: SANKEY_PAD_BOTTOM,
      nodeGap: SANKEY_NODE_GAP,
      leftDetail: "cells",
    }
  );
}

describe("sankey Categories golden image", () => {
  it("matches the committed Categories layout snapshot", () => {
    const layout = goldenCategoriesLayout();
    // Full layout JSON: nodes, ribbons, sub-ribbons, gradient stops, fills,
    // label anchors. Regenerate only by deleting the snap after a deliberate
    // Categories change — never to quiet a regression.
    expect(JSON.parse(JSON.stringify(layout))).toMatchSnapshot();
  });

  it("pins the Categories through-color contract explicitly", () => {
    const layout = goldenCategoriesLayout();
    expect(layout.sources.map((s) => s.name)).toEqual(["Payroll"]);
    expect(layout.middles.map((m) => m.name)).toEqual(["Bills", "Everyday"]);
    expect(layout.targets.map((t) => t.name)).toEqual([
      "Mortgage Interest",
      "Groceries",
      "Electric Bill",
      "Remaining",
    ]);
    expect(layout.remainingTargetIndex).toBe(3);
    // Two income→group bands plus the full-width plug; one ribbon per cell.
    expect(layout.linksLeft).toHaveLength(3);
    expect(layout.linksRight).toHaveLength(3);
    // Bills nests two category sub-ribbons, Everyday one; the plug stays whole.
    expect(layout.leftCells).toHaveLength(3);

    const mortgage = colorForName("Mortgage Interest");
    const groceries = colorForName("Groceries");
    const electric = colorForName("Electric Bill");
    // Right hop: each ribbon carries its final category's color.
    expect(layout.linksRight.map((l) => l.fill)).toEqual([mortgage, electric, groceries]);
    // Left hop: each sub-ribbon carries its downstream cell's color, and every
    // ribbon's fill equals its final destination bar's fill exactly.
    expect(layout.leftCells.map((c) => c.fill)).toEqual([mortgage, electric, groceries]);
    for (const sub of layout.leftCells) {
      expect(sub.fill).toBe(layout.targets[sub.targetIndex]!.fill);
    }
    // The plug ribbon is the only green on the left hop.
    const plugBand = layout.linksLeft.find((l) => l.targetIndex >= layout.middles.length)!;
    expect(plugBand.fill).toBe(REMAINING_COLOR);
    // No group hue survives on any drawn ribbon: the source slots tile the
    // income bar in category colors with the plug green last.
    expect(layout.sourceFills).toHaveLength(1);
    expect(layout.sourceFills[0]!.map((s) => s.color)).toEqual([
      mortgage,
      mortgage,
      electric,
      electric,
      groceries,
      groceries,
      REMAINING_COLOR,
      REMAINING_COLOR,
    ]);
  });
});

describe("sankey Merchants through-color", () => {
  it("subdivides each income band into per-merchant sub-ribbons in final colors", () => {
    // A merchant split across groups (Airbnb in Bills + Everyday): with
    // leftDetail "cells" — what the Merchants view requests — every band
    // subdivides per downstream merchant cell, each slice carrying the
    // merchant's own final color and landing in contiguous per-color blocks
    // at the outgoing cell's thickness, with the income gradient matching.
    const layout = layoutGroupedIncomeSankey(
      [merged("Payroll", 200000), merged("Bonus", 50000)],
      [merged("Bills", 110000), merged("Everyday", 140000)],
      [merged("Airbnb", 100000), merged("Bank of Example", 100000), merged("Whole Foods", 50000)],
      [
        { groupIndex: 0, targetIndex: 0, value: 10000 },
        { groupIndex: 0, targetIndex: 1, value: 100000 },
        { groupIndex: 1, targetIndex: 0, value: 90000 },
        { groupIndex: 1, targetIndex: 2, value: 50000 },
      ],
      { width: 800, height: 400, leftDetail: "cells" }
    );
    // Four bands (2 incomes x 2 groups), two cells each: 8 sub-ribbons.
    expect(layout.linksLeft).toHaveLength(4);
    expect(layout.leftCells).toHaveLength(8);
    // Every sub-ribbon carries its FINAL destination color — never the group.
    const billsHue = layout.middles[0]!.fill;
    const everydayHue = layout.middles[1]!.fill;
    for (const sub of layout.leftCells) {
      expect(sub.fill).toBe(layout.targets[sub.targetIndex]!.fill);
      expect(sub.fill).not.toBe(billsHue);
      expect(sub.fill).not.toBe(everydayHue);
    }
    // Same-color target slots land adjacent: one contiguous block per color
    // within each middle, at exactly the thickness the cell leaves it.
    for (let m = 0; m < layout.middles.length; m++) {
      const subs = layout.leftCells.filter((c) => c.middleIndex === m);
      const byTarget = new Map<number, { y0: number; y1: number }[]>();
      for (const sub of subs) {
        const slots = byTarget.get(sub.targetIndex) ?? [];
        slots.push({ y0: sub.ty0, y1: sub.ty1 });
        byTarget.set(sub.targetIndex, slots);
      }
      for (const [targetIndex, slots] of byTarget) {
        slots.sort((a, b) => a.y0 - b.y0);
        for (let k = 1; k < slots.length; k++) {
          expect(slots[k]!.y0).toBeCloseTo(slots[k - 1]!.y1, 6);
        }
        const blockH = slots[slots.length - 1]!.y1 - slots[0]!.y0;
        const cell = layout.linksRight.find(
          (l) => l.sourceIndex === m && l.targetIndex === targetIndex
        )!;
        expect(blockH).toBeCloseTo(cell.sy1 - cell.sy0, 6);
      }
    }
    // Income gradients segment by the same merchant slices: every segment
    // meets its sub-ribbon exactly, in the same fill.
    const airbnb = colorForName("Airbnb");
    const bank = colorForName("Bank of Example");
    const whole = colorForName("Whole Foods");
    expect(layout.sourceFills).toHaveLength(2);
    for (const stops of layout.sourceFills) {
      expect(stops.map((s) => s.color)).toEqual([
        airbnb,
        airbnb,
        bank,
        bank,
        airbnb,
        airbnb,
        whole,
        whole,
      ]);
    }
    for (let i = 0; i < layout.sources.length; i++) {
      const bar = layout.sources[i]!;
      const stops = layout.sourceFills[i]!;
      const subs = layout.leftCells.filter((c) => c.sourceIndex === i);
      subs.forEach((sub, k) => {
        expect(bar.y + stops[2 * k]!.offset * bar.h).toBeCloseTo(sub.sy0, 6);
        expect(bar.y + stops[2 * k + 1]!.offset * bar.h).toBeCloseTo(sub.sy1, 6);
      });
    }
  });
});
