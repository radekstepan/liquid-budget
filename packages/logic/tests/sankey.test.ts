import { describe, expect, it } from "vitest";
import {
  buildFlowColumns,
  computeIncomeBreakdown,
  computeSpendingBreakdown,
  layoutIncomeSankey,
  layoutSankey,
  mergeBelowThreshold,
  OTHER_BUCKET_LABEL,
  OVERSPENT_LABEL,
  REMAINING_LABEL,
  sankeyContentHeight,
  SANKEY_MIN_PITCH,
  SANKEY_NODE_GAP,
  SANKEY_NODE_MIN_HEIGHT,
  SANKEY_PAD_BOTTOM,
  SANKEY_PAD_TOP,
  type MergedSpendingItem,
} from "../src/sankey.js";
import type { BudgetData, Transaction } from "../src/types.js";

let nextId = 1;
function txn(
  date: string,
  payee: string,
  amountCents: number,
  categoryId: number | null = null,
  extra: Partial<Transaction> = {}
): Transaction {
  return {
    id: nextId++,
    accountId: 1,
    categoryId,
    date,
    payee,
    memo: "",
    amount: String(amountCents),
    status: "c",
    ...extra,
  };
}

function makeData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget", balance: "0", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid", groupLabel: "Budget", balance: "0", onBudget: true, sort: 1 },
    ],
    groups: [{ id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false }],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 11, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      txn("2026-04-05", "Whole Foods", -20000, 10),
      txn("2026-04-10", "Landlord", -30000, 11),
      txn("2026-05-05", "Whole Foods", -10000, 10),
      txn("2026-05-12", "Corner Shop", -15000, null),
      txn("2026-05-01", "Payroll", 300000, null),
      txn("2026-06-05", "Whole Foods", -5000, 10),
    ],
    recurring: [],
  };
}

describe("computeSpendingBreakdown", () => {
  it("aggregates by category over the month range, sorted descending", () => {
    const items = computeSpendingBreakdown(makeData(), "2026-04", "2026-06", "categories");
    expect(items).toEqual([
      { name: "Groceries", value: 35000 },
      { name: "Rent", value: 30000 },
    ]);
  });

  it("respects a narrowed month range", () => {
    const items = computeSpendingBreakdown(makeData(), "2026-06", "2026-06", "categories");
    expect(items).toEqual([{ name: "Groceries", value: 5000 }]);
  });

  it("swaps start/end when reversed", () => {
    const items = computeSpendingBreakdown(makeData(), "2026-06", "2026-04", "categories");
    expect(items).toEqual([
      { name: "Groceries", value: 35000 },
      { name: "Rent", value: 30000 },
    ]);
  });

  it("aggregates by merchant (payee), including uncategorized rows", () => {
    const items = computeSpendingBreakdown(makeData(), "2026-04", "2026-06", "merchants");
    expect(items).toEqual([
      { name: "Whole Foods", value: 35000 },
      { name: "Landlord", value: 30000 },
      { name: "Corner Shop", value: 15000 },
    ]);
  });

  it("excludes income payees in merchant mode", () => {
    const items = computeSpendingBreakdown(makeData(), "2026-04", "2026-06", "merchants");
    expect(items.some((i) => i.name === "Payroll")).toBe(false);
  });

  it("excludes split parents and counts only split children", () => {
    const data = makeData();
    data.transactions.push(
      txn("2026-06-10", "Split Store", -10000, null, { id: 900 }),
      txn("2026-06-10", "Split Store", -7000, 10, { id: 901, parentId: 900 }),
      txn("2026-06-10", "Split Store", -3000, 11, { id: 902, parentId: 900 })
    );
    const items = computeSpendingBreakdown(data, "2026-06", "2026-06", "categories");
    expect(items).toEqual([
      { name: "Groceries", value: 12000 },
      { name: "Rent", value: 3000 },
    ]);
  });

  it("nets refunds against outflows and drops groups netting to zero or less", () => {
    const data = makeData();
    data.transactions.push(
      txn("2026-06-10", "Clothing Store", -20000, 10),
      txn("2026-06-11", "Clothing Store Return", 15000, 10),
      txn("2026-06-12", "Freebie", -5000, 11),
      txn("2026-06-13", "Freebie Refund", 5000, 11)
    );
    const items = computeSpendingBreakdown(data, "2026-06", "2026-06", "categories");
    // Groceries: 5000 + 20000 - 15000 = 10000; Rent: 5000 - 5000 = 0 (dropped).
    expect(items).toEqual([{ name: "Groceries", value: 10000 }]);
  });

  it("includes categorized transfers in category mode", () => {
    const data = makeData();
    data.transactions.push(
      txn("2026-06-15", "Transfer : Savings", -50000, 11, { transferAccountId: 2 })
    );
    const items = computeSpendingBreakdown(data, "2026-06", "2026-06", "categories");
    expect(items).toEqual([
      { name: "Rent", value: 50000 },
      { name: "Groceries", value: 5000 },
    ]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(computeSpendingBreakdown(makeData(), "2020-01", "2020-02", "categories")).toEqual([]);
    expect(computeSpendingBreakdown(makeData(), "2020-01", "2020-02", "merchants")).toEqual([]);
  });
});

describe("mergeBelowThreshold", () => {
  const items = [
    { name: "Big", value: 10000 },
    { name: "Mid", value: 4000 },
    { name: "Small", value: 1000 },
    { name: "Tiny", value: 200 },
  ];

  it("passes everything through when the threshold is 0", () => {
    const merged = mergeBelowThreshold(items, 0);
    expect(merged.items).toEqual(items.map((it) => ({ ...it, mergedCount: 1 })));
    expect(merged.otherCount).toBe(0);
    expect(merged.otherValue).toBe(0);
  });

  it("treats negative thresholds as disabled", () => {
    const merged = mergeBelowThreshold(items, -500);
    expect(merged.items).toHaveLength(4);
    expect(merged.otherCount).toBe(0);
  });

  it("merges items strictly below the threshold into a trailing Other bucket", () => {
    const merged = mergeBelowThreshold(items, 5000);
    expect(merged.items).toEqual([
      { name: "Big", value: 10000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 5200, mergedCount: 3 },
    ]);
    expect(merged.otherCount).toBe(3);
    expect(merged.otherValue).toBe(5200);
  });

  it("keeps items equal to the threshold (strictly-below comparison)", () => {
    const merged = mergeBelowThreshold(items, 4000);
    expect(merged.items[0]).toEqual({ name: "Big", value: 10000, mergedCount: 1 });
    expect(merged.items[1]).toEqual({ name: "Mid", value: 4000, mergedCount: 1 });
    expect(merged.otherCount).toBe(2);
  });

  it("merges everything into a single Other row when the threshold exceeds all values", () => {
    const merged = mergeBelowThreshold(items, 999999);
    expect(merged.items).toEqual([
      { name: OTHER_BUCKET_LABEL, value: 15200, mergedCount: 4 },
    ]);
    expect(merged.otherCount).toBe(4);
    expect(merged.otherValue).toBe(15200);
  });

  it("returns empty output with no phantom Other for empty input", () => {
    const merged = mergeBelowThreshold([], 5000);
    expect(merged.items).toEqual([]);
    expect(merged.otherCount).toBe(0);
    expect(merged.otherValue).toBe(0);
  });
});

function merged(name: string, value: number): MergedSpendingItem {
  return { name, value, mergedCount: 1 };
}

describe("layoutSankey", () => {
  const items = [merged("A", 6000), merged("B", 3000), merged("C", 1000)];

  it("returns an empty layout with total 0 for empty input", () => {
    const layout = layoutSankey([], { width: 800, height: 400 });
    expect(layout.total).toBe(0);
    expect(layout.nodes).toEqual([]);
    expect(layout.links).toEqual([]);
    expect(layout.source.h).toBe(0);
  });

  it("returns an empty layout for non-positive totals (no NaN geometry)", () => {
    const layout = layoutSankey([merged("X", 0)], { width: 800, height: 400 });
    expect(layout.total).toBe(0);
    expect(layout.nodes).toEqual([]);
    expect(layout.links).toEqual([]);
  });

  it("sums link bands to the total and keeps source/link/node heights consistent", () => {
    const layout = layoutSankey(items, { width: 800, height: 400 });
    expect(layout.total).toBe(10000);
    expect(layout.nodes).toHaveLength(3);
    expect(layout.links).toHaveLength(3);
    // Link band heights match their node heights exactly.
    for (let i = 0; i < 3; i++) {
      const link = layout.links[i]!;
      const node = layout.nodes[i]!;
      expect(link.sy1 - link.sy0).toBeCloseTo(node.h, 6);
      expect(link.ty1 - link.ty0).toBeCloseTo(node.h, 6);
      expect(link.ty0).toBeCloseTo(node.y, 6);
      expect(link.name).toBe(node.name);
    }
    // Source spans exactly the stacked bands.
    const first = layout.links[0]!;
    const last = layout.links[2]!;
    expect(layout.source.y).toBeCloseTo(first.sy0, 6);
    expect(layout.source.y + layout.source.h).toBeCloseTo(last.sy1, 6);
  });

  it("stacks nodes in input order with gaps inside the padded plot area", () => {
    const W = 800;
    const H = 400;
    const layout = layoutSankey(items, { width: W, height: H, padTop: 8, padBottom: 8 });
    let prevBottom = 8;
    for (const node of layout.nodes) {
      expect(node.y).toBeGreaterThanOrEqual(prevBottom - 1e-9);
      expect(node.x + node.w).toBeLessThanOrEqual(W);
      expect(node.y + node.h).toBeLessThanOrEqual(H - 8 + 1e-9);
      prevBottom = node.y + node.h + 6;
    }
    expect(layout.nodes.map((n) => n.name)).toEqual(["A", "B", "C"]);
  });

  it("keeps tiny flows hoverable via the minimum node height", () => {
    const tiny = [merged("Big", 100000), merged("Dust", 1)];
    const layout = layoutSankey(tiny, { width: 800, height: 400, minNodeHeight: 8 });
    expect(layout.nodes[1]!.h).toBeGreaterThanOrEqual(8 - 1e-9);
    // The bands still stack without overlap and stay in bounds.
    expect(layout.nodes[1]!.y).toBeGreaterThanOrEqual(layout.nodes[0]!.y + layout.nodes[0]!.h);
    expect(layout.nodes[1]!.y + layout.nodes[1]!.h).toBeLessThanOrEqual(400 - 8 + 1e-9);
  });

  it("scales down gracefully when minimums exceed the plot (pathological all-tiny case)", () => {
    const many = Array.from({ length: 50 }, (_, i) => merged(`M${i}`, 1));
    const layout = layoutSankey(many, { width: 800, height: 200, minNodeHeight: 8 });
    const last = layout.nodes[layout.nodes.length - 1]!;
    expect(last.y + last.h).toBeLessThanOrEqual(200 - 8 + 1e-6);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.y)).toBe(true);
      expect(Number.isFinite(node.h)).toBe(true);
    }
  });

  it("emits closed ribbon paths running left-to-right", () => {
    const layout = layoutSankey(items, { width: 800, height: 400 });
    for (const link of layout.links) {
      expect(link.d).toMatch(/^M .* Z$/);
      expect(link.d).toContain("C");
      expect(link.x1).toBeGreaterThan(link.x0);
    }
  });

  it("grows content height to preserve the minimum label pitch", () => {
    expect(sankeyContentHeight(60, 400)).toBe(60 * SANKEY_MIN_PITCH + 56);
    expect(sankeyContentHeight(3, 400)).toBe(400);
    expect(sankeyContentHeight(0, 400)).toBe(400);
  });

  it("keeps every row pitch at the label minimum when sized by the view contract", () => {
    const many = Array.from({ length: 60 }, (_, i) => merged(`M${i}`, Math.max(1, 60000 - i * 997)));
    const height = sankeyContentHeight(many.length, 400);
    const layout = layoutSankey(many, {
      width: 800,
      height,
      padTop: SANKEY_PAD_TOP,
      padBottom: SANKEY_PAD_BOTTOM,
      nodeGap: SANKEY_NODE_GAP,
      minNodeHeight: SANKEY_NODE_MIN_HEIGHT,
    });
    expect(layout.nodes).toHaveLength(60);
    for (let i = 1; i < layout.nodes.length; i++) {
      expect(layout.nodes[i]!.y - layout.nodes[i - 1]!.y).toBeGreaterThanOrEqual(
        SANKEY_MIN_PITCH - 1e-9
      );
    }
    const last = layout.nodes[layout.nodes.length - 1]!;
    expect(last.y + last.h).toBeLessThanOrEqual(height - SANKEY_PAD_BOTTOM + 1e-6);
  });
});

describe("computeIncomeBreakdown", () => {
  it("aggregates income by source over the month range, sorted descending", () => {
    const items = computeIncomeBreakdown(makeData(), "2026-04", "2026-06");
    expect(items).toEqual([{ name: "Payroll", value: 300000 }]);
  });

  it("respects a narrowed month range and swaps reversed bounds", () => {
    expect(computeIncomeBreakdown(makeData(), "2026-06", "2026-06")).toEqual([]);
    expect(computeIncomeBreakdown(makeData(), "2026-05", "2026-05")).toEqual([
      { name: "Payroll", value: 300000 },
    ]);
    expect(computeIncomeBreakdown(makeData(), "2026-06", "2026-04")).toEqual([
      { name: "Payroll", value: 300000 },
    ]);
  });

  it("ignores categorized rows and uncategorized outflows", () => {
    const data = makeData();
    data.transactions.push(
      txn("2026-06-10", "Side Gig", 99999, 10),
      txn("2026-06-11", "Corner Shop", -15000, null)
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([]);
  });

  it("excludes split parents and counts only split children", () => {
    const data = makeData();
    data.transactions.push(
      txn("2026-06-10", "Split Income", 40000, null, { id: 900 }),
      txn("2026-06-10", "Split Income", 30000, null, { id: 901, parentId: 900 }),
      txn("2026-06-10", "Split Income", 10000, 10, { id: 902, parentId: 900 })
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "Split Income", value: 30000 },
    ]);
  });

  it("excludes uncategorized outflows (they belong to merchant spending)", () => {
    const data = makeData();
    data.transactions.push(
      txn("2026-06-10", "Payroll", -50000, null),
      txn("2026-06-11", "Bonus", 20000, null),
      txn("2026-06-12", "Bonus", -20000, null)
    );
    // Negative uncategorized rows are outflows, not income corrections: they
    // never net against (or appear in) the income side. Net totals stay
    // right because merchant spending picks those rows up instead.
    expect(computeIncomeBreakdown(data, "2026-04", "2026-06")).toEqual([
      { name: "Payroll", value: 300000 },
      { name: "Bonus", value: 20000 },
    ]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(computeIncomeBreakdown(makeData(), "2020-01", "2020-02")).toEqual([]);
  });
});

describe("buildFlowColumns", () => {
  const spending = [{ name: "A", value: 6000, mergedCount: 1 }];

  it("adds a trailing Remaining plug when income exceeds spending", () => {
    const cols = buildFlowColumns(spending, [{ name: "Pay", value: 10000 }]);
    expect(cols.incomeTotal).toBe(10000);
    expect(cols.spendingTotal).toBe(6000);
    expect(cols.flowTotal).toBe(10000);
    expect(cols.sources).toEqual([{ name: "Pay", value: 10000, mergedCount: 1 }]);
    expect(cols.targets).toEqual([
      { name: "A", value: 6000, mergedCount: 1 },
      { name: REMAINING_LABEL, value: 4000, mergedCount: 1 },
    ]);
  });

  it("adds a trailing Overspent plug when spending exceeds income", () => {
    const cols = buildFlowColumns(spending, [{ name: "Pay", value: 2500 }]);
    expect(cols.flowTotal).toBe(6000);
    expect(cols.sources).toEqual([
      { name: "Pay", value: 2500, mergedCount: 1 },
      { name: OVERSPENT_LABEL, value: 3500, mergedCount: 1 },
    ]);
    expect(cols.targets).toEqual(spending);
  });

  it("adds no plug when income and spending balance exactly", () => {
    const cols = buildFlowColumns(spending, [{ name: "Pay", value: 6000 }]);
    expect(cols.flowTotal).toBe(6000);
    expect(cols.sources).toHaveLength(1);
    expect(cols.targets).toHaveLength(1);
  });

  it("handles all-empty input with a zero flow", () => {
    const cols = buildFlowColumns([], []);
    expect(cols.flowTotal).toBe(0);
    expect(cols.sources).toEqual([]);
    expect(cols.targets).toEqual([]);
  });

  it("preserves merged spending rows untouched (Other keeps its count)", () => {
    const cols = buildFlowColumns(
      [
        { name: "A", value: 6000, mergedCount: 1 },
        { name: OTHER_BUCKET_LABEL, value: 2000, mergedCount: 4 },
      ],
      [{ name: "Pay", value: 10000 }]
    );
    expect(cols.targets[1]).toEqual({
      name: OTHER_BUCKET_LABEL,
      value: 2000,
      mergedCount: 4,
    });
    expect(cols.targets[2]).toEqual({
      name: REMAINING_LABEL,
      value: 2000,
      mergedCount: 1,
    });
  });
});

describe("layoutIncomeSankey", () => {
  const cols = buildFlowColumns(
    [
      { name: "A", value: 6000, mergedCount: 1 },
      { name: "B", value: 3000, mergedCount: 1 },
      { name: "C", value: 1000, mergedCount: 1 },
    ],
    [
      { name: "Pay", value: 8000 },
      { name: "Gig", value: 3000 },
    ]
  );

  it("returns an empty layout with zero middle for empty input (no NaN)", () => {
    const layout = layoutIncomeSankey([], [], { width: 800, height: 400 });
    expect(layout.flowTotal).toBe(0);
    expect(layout.middle.h).toBe(0);
    expect(layout.sources).toEqual([]);
    expect(layout.targets).toEqual([]);
    expect(layout.inLinks).toEqual([]);
    expect(layout.outLinks).toEqual([]);
    expect(Number.isFinite(layout.middle.x)).toBe(true);
    expect(Number.isFinite(layout.sourceLabelX)).toBe(true);
    expect(Number.isFinite(layout.targetLabelX)).toBe(true);
  });

  it("attaches every band to the middle node with matching heights", () => {
    const layout = layoutIncomeSankey(cols.sources, cols.targets, {
      width: 800,
      height: 400,
    });
    expect(layout.flowTotal).toBe(11000);
    expect(layout.sources).toHaveLength(2);
    // A + B + C plus the Remaining plug for the $100 surplus.
    expect(layout.targets).toHaveLength(4);
    expect(layout.inLinks).toHaveLength(2);
    expect(layout.outLinks).toHaveLength(4);

    // Middle sits strictly between the two columns.
    const srcRight = layout.sources[0]!.x + layout.sources[0]!.w;
    expect(layout.middle.x).toBeGreaterThan(srcRight);
    expect(layout.middle.x + layout.middle.w).toBeLessThan(layout.targets[0]!.x);

    // In-bands run from their source bar into the middle node.
    for (let i = 0; i < layout.inLinks.length; i++) {
      const link = layout.inLinks[i]!;
      const node = layout.sources[i]!;
      expect(link.x0).toBeCloseTo(node.x + node.w, 6);
      expect(link.x1).toBeCloseTo(layout.middle.x, 6);
      expect(link.sy0).toBeCloseTo(node.y, 6);
      expect(link.sy1 - link.sy0).toBeCloseTo(node.h, 6);
      expect(link.ty0).toBeGreaterThanOrEqual(layout.middle.y - 1e-9);
      expect(link.ty1).toBeLessThanOrEqual(layout.middle.y + layout.middle.h + 1e-9);
    }
    // Out-bands run from the middle node to their target bar.
    for (let i = 0; i < layout.outLinks.length; i++) {
      const link = layout.outLinks[i]!;
      const node = layout.targets[i]!;
      expect(link.x0).toBeCloseTo(layout.middle.x + layout.middle.w, 6);
      expect(link.x1).toBeCloseTo(node.x, 6);
      expect(link.ty0).toBeCloseTo(node.y, 6);
      expect(link.ty1 - link.ty0).toBeCloseTo(node.h, 6);
      expect(link.sy0).toBeGreaterThanOrEqual(layout.middle.y - 1e-9);
      expect(link.sy1).toBeLessThanOrEqual(layout.middle.y + layout.middle.h + 1e-9);
    }
  });

  it("stacks unequal sides independently, top-aligned under one middle", () => {
    const oneSided = buildFlowColumns(
      [
        { name: "A", value: 5000, mergedCount: 1 },
        { name: "B", value: 3000, mergedCount: 1 },
        { name: "C", value: 2000, mergedCount: 1 },
      ],
      [{ name: "Pay", value: 10000 }]
    );
    const layout = layoutIncomeSankey(oneSided.sources, oneSided.targets, {
      width: 800,
      height: 400,
      padTop: 28,
    });
    expect(layout.sources).toHaveLength(1);
    expect(layout.sources[0]!.y).toBeCloseTo(28, 6);
    expect(layout.targets[0]!.y).toBeCloseTo(28, 6);
    expect(layout.middle.y).toBeCloseTo(28, 6);
    // Middle covers the taller (3-row) stack.
    const lastTgt = layout.targets[2]!;
    expect(layout.middle.h).toBeGreaterThanOrEqual(lastTgt.y + lastTgt.h - 28 - 1e-9);
  });

  it("keeps label anchors clear of their bars", () => {
    const layout = layoutIncomeSankey(cols.sources, cols.targets, {
      width: 800,
      height: 400,
      padLeft: 112,
    });
    expect(layout.sourceLabelX).toBeLessThanOrEqual(layout.sources[0]!.x - 8);
    expect(layout.targetLabelX).toBeGreaterThanOrEqual(
      layout.targets[0]!.x + layout.targets[0]!.w + 8
    );
  });
});
