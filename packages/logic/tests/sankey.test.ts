import { describe, expect, it } from "vitest";
import {
  computeDirectFlowLinks,
  computeIncomeBreakdown,
  computeSpendingBreakdown,
  layoutDirectIncomeSankey,
  layoutSankey,
  mergeBelowThreshold,
  OTHER_BUCKET_LABEL,
  REMAINING_LABEL,
  sankeyContentHeight,
  SANKEY_LEFT_LABEL_INSET,
  SANKEY_MIN_PITCH,
  SANKEY_NODE_GAP,
  SANKEY_NODE_MIN_HEIGHT,
  SANKEY_PAD_BOTTOM,
  SANKEY_PAD_TOP,
  SANKEY_SOURCE_GUTTER,
  SANKEY_SOURCE_LABEL_GAP,
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

describe("computeDirectFlowLinks", () => {
  it("splits every expense across incomes by income share (fungible allocation)", () => {
    const model = computeDirectFlowLinks(
      [
        { name: "Pay", value: 8000, mergedCount: 1 },
        { name: "Gig", value: 2000, mergedCount: 1 },
      ],
      [
        { name: "A", value: 6000, mergedCount: 1 },
        { name: "B", value: 4000, mergedCount: 1 },
      ]
    );
    expect(model.incomeTotal).toBe(10000);
    expect(model.spendingTotal).toBe(10000);
    // 80/20 income shares applied to each expense, target-major.
    expect(model.links).toEqual([
      { sourceIndex: 0, targetIndex: 0, value: 4800 },
      { sourceIndex: 1, targetIndex: 0, value: 1200 },
      { sourceIndex: 0, targetIndex: 1, value: 3200 },
      { sourceIndex: 1, targetIndex: 1, value: 800 },
    ]);
    expect(model.funded).toEqual([6000, 4000]);
    expect(model.unfunded).toEqual([0, 0]);
  });

  it("conserves flow per source and per target", () => {
    const sources = [
      { name: "Pay", value: 8000, mergedCount: 1 },
      { name: "Gig", value: 3000, mergedCount: 1 },
    ];
    const spending = [
      { name: "A", value: 6000, mergedCount: 1 },
      { name: "B", value: 3000, mergedCount: 1 },
      { name: "C", value: 1000, mergedCount: 1 },
    ];
    const model = computeDirectFlowLinks(sources, spending);
    // A + B + C plus the Remaining plug for the $100 surplus.
    expect(model.targets).toHaveLength(4);
    for (let i = 0; i < sources.length; i++) {
      const out = model.links
        .filter((l) => l.sourceIndex === i)
        .reduce((s, l) => s + l.value, 0);
      expect(out).toBeCloseTo(sources[i]!.value, 9);
    }
    for (let j = 0; j < model.targets.length; j++) {
      const into = model.links
        .filter((l) => l.targetIndex === j)
        .reduce((s, l) => s + l.value, 0);
      expect(into).toBeCloseTo(model.funded[j] ?? 0, 9);
      expect((model.funded[j] ?? 0) + (model.unfunded[j] ?? 0)).toBeCloseTo(
        model.targets[j]!.value,
        9
      );
    }
  });

  it("adds a trailing Remaining plug, fed proportionally, when income exceeds spending", () => {
    const model = computeDirectFlowLinks(
      [
        { name: "Pay", value: 8000, mergedCount: 1 },
        { name: "Gig", value: 2000, mergedCount: 1 },
      ],
      [{ name: "A", value: 6000, mergedCount: 1 }]
    );
    expect(model.targets).toEqual([
      { name: "A", value: 6000, mergedCount: 1 },
      { name: REMAINING_LABEL, value: 4000, mergedCount: 1 },
    ]);
    expect(model.funded).toEqual([6000, 4000]);
    expect(model.unfunded).toEqual([0, 0]);
    // The $4000 surplus draws 80/20 from the two incomes, like any expense.
    expect(
      model.links.filter((l) => l.targetIndex === 1).map((l) => l.value)
    ).toEqual([3200, 800]);
  });

  it("funds every expense pro-rata with per-target unfunded remainders when spending exceeds income", () => {
    const model = computeDirectFlowLinks(
      [{ name: "Pay", value: 3000, mergedCount: 1 }],
      [{ name: "A", value: 6000, mergedCount: 1 }]
    );
    // No phantom income source is invented: the single source stands alone.
    expect(model.sources).toEqual([{ name: "Pay", value: 3000, mergedCount: 1 }]);
    expect(model.targets).toEqual([{ name: "A", value: 6000, mergedCount: 1 }]);
    expect(model.funded).toEqual([3000]);
    expect(model.unfunded).toEqual([3000]);
    expect(model.links).toEqual([{ sourceIndex: 0, targetIndex: 0, value: 3000 }]);
  });

  it("applies a uniform coverage ratio across expenses under a shortfall", () => {
    const model = computeDirectFlowLinks(
      [
        { name: "Pay", value: 4000, mergedCount: 1 },
        { name: "Gig", value: 2000, mergedCount: 1 },
      ],
      [
        { name: "A", value: 6000, mergedCount: 1 },
        { name: "B", value: 3000, mergedCount: 1 },
      ]
    );
    // $6000 income over $9000 spending: every expense is 2/3 funded.
    expect(model.funded[0]).toBeCloseTo(4000, 9);
    expect(model.funded[1]).toBeCloseTo(2000, 9);
    expect(model.unfunded[0]).toBeCloseTo(2000, 9);
    expect(model.unfunded[1]).toBeCloseTo(1000, 9);
    // Sources still fully flow out (Pay 2/3 of income, Gig 1/3).
    const outPay = model.links
      .filter((l) => l.sourceIndex === 0)
      .reduce((s, l) => s + l.value, 0);
    expect(outPay).toBeCloseTo(4000, 9);
  });

  it("routes all income to Remaining when there is no spending", () => {
    const model = computeDirectFlowLinks(
      [{ name: "Pay", value: 10000, mergedCount: 1 }],
      []
    );
    expect(model.targets).toEqual([
      { name: REMAINING_LABEL, value: 10000, mergedCount: 1 },
    ]);
    expect(model.links).toEqual([{ sourceIndex: 0, targetIndex: 0, value: 10000 }]);
  });

  it("reports every expense fully unfunded with no links when there is no income", () => {
    const model = computeDirectFlowLinks([], [{ name: "A", value: 6000, mergedCount: 1 }]);
    expect(model.incomeTotal).toBe(0);
    expect(model.targets).toEqual([{ name: "A", value: 6000, mergedCount: 1 }]);
    expect(model.funded).toEqual([0]);
    expect(model.unfunded).toEqual([6000]);
    expect(model.links).toEqual([]);
  });

  it("drops zero and negative values and handles all-empty input", () => {
    const model = computeDirectFlowLinks(
      [merged("Zero", 0), merged("Neg", -500)],
      [merged("Nil", 0)]
    );
    expect(model.incomeTotal).toBe(0);
    expect(model.spendingTotal).toBe(0);
    expect(model.sources).toEqual([]);
    expect(model.targets).toEqual([]);
    expect(model.links).toEqual([]);
    const empty = computeDirectFlowLinks([], []);
    expect(empty.incomeTotal).toBe(0);
    expect(empty.spendingTotal).toBe(0);
    expect(empty.links).toEqual([]);
  });

  it("preserves merged spending rows untouched (Other keeps its count)", () => {
    const model = computeDirectFlowLinks(
      [{ name: "Pay", value: 10000, mergedCount: 1 }],
      [
        { name: "A", value: 6000, mergedCount: 1 },
        { name: OTHER_BUCKET_LABEL, value: 2000, mergedCount: 4 },
      ]
    );
    expect(model.targets[1]).toEqual({
      name: OTHER_BUCKET_LABEL,
      value: 2000,
      mergedCount: 4,
    });
    expect(model.targets[2]).toEqual({
      name: REMAINING_LABEL,
      value: 2000,
      mergedCount: 1,
    });
  });

  it("routes merged income buckets (Other keeps its count on the source side)", () => {
    const model = computeDirectFlowLinks(
      [
        { name: "Pay", value: 8000, mergedCount: 1 },
        { name: OTHER_BUCKET_LABEL, value: 2000, mergedCount: 3 },
      ],
      [{ name: "A", value: 6000, mergedCount: 1 }]
    );
    expect(model.sources[1]).toEqual({
      name: OTHER_BUCKET_LABEL,
      value: 2000,
      mergedCount: 3,
    });
    // The Other income funds its 20% share of the expense and of Remaining.
    const otherLinks = model.links.filter((l) => l.sourceIndex === 1);
    expect(otherLinks.map((l) => [l.targetIndex, l.value])).toEqual([
      [0, 1200],
      [1, 800],
    ]);
  });

  it("conserves flow when both columns are merged", () => {
    const sources = [
      { name: "Pay", value: 8000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 2000, mergedCount: 3 },
    ];
    const spending = [
      { name: "A", value: 6000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 3000, mergedCount: 2 },
    ];
    const model = computeDirectFlowLinks(sources, spending);
    for (let i = 0; i < sources.length; i++) {
      const out = model.links
        .filter((l) => l.sourceIndex === i)
        .reduce((s, l) => s + l.value, 0);
      expect(out).toBeCloseTo(sources[i]!.value, 9);
    }
    for (let j = 0; j < model.targets.length; j++) {
      const into = model.links
        .filter((l) => l.targetIndex === j)
        .reduce((s, l) => s + l.value, 0);
      expect(into).toBeCloseTo(model.funded[j] ?? 0, 9);
      expect((model.funded[j] ?? 0) + (model.unfunded[j] ?? 0)).toBeCloseTo(
        model.targets[j]!.value,
        9
      );
    }
  });
});

describe("layoutDirectIncomeSankey", () => {
  const sources = [
    merged("Pay", 8000),
    merged("Gig", 3000),
  ];
  const spending = [merged("A", 6000), merged("B", 3000), merged("C", 1000)];

  it("returns an empty layout with no middle node for empty input (no NaN)", () => {
    const layout = layoutDirectIncomeSankey([], [], { width: 800, height: 400 });
    expect(layout.flowTotal).toBe(0);
    expect(layout.sources).toEqual([]);
    expect(layout.targets).toEqual([]);
    expect(layout.links).toEqual([]);
    expect("middle" in layout).toBe(false);
    expect(Number.isFinite(layout.sourceLabelX)).toBe(true);
    expect(Number.isFinite(layout.targetLabelX)).toBe(true);
  });

  it("returns finite degenerate geometry for zero/negative values", () => {
    const layout = layoutDirectIncomeSankey(
      [merged("Zero", 0)],
      [merged("Neg", -100)],
      { width: 800, height: 400 }
    );
    expect(layout.flowTotal).toBe(0);
    expect(layout.sources).toEqual([]);
    expect(layout.targets).toEqual([]);
    expect(layout.links).toEqual([]);
    for (const v of [
      layout.incomeTotal,
      layout.spendingTotal,
      layout.flowTotal,
      layout.sourceLabelX,
      layout.targetLabelX,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("connects every income directly to every expense with no middle node", () => {
    const layout = layoutDirectIncomeSankey(sources, spending, {
      width: 800,
      height: 400,
    });
    expect(layout.incomeTotal).toBe(11000);
    expect(layout.spendingTotal).toBe(10000);
    expect(layout.flowTotal).toBe(11000);
    expect(layout.sources).toHaveLength(2);
    // A + B + C plus the Remaining plug for the $100 surplus.
    expect(layout.targets).toHaveLength(4);
    // Dense ribbons: 2 sources x 4 targets, target-major.
    expect(layout.links).toHaveLength(8);
    expect("middle" in layout).toBe(false);
    expect(layout.links.map((l) => [l.sourceIndex, l.targetIndex])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 2],
      [1, 2],
      [0, 3],
      [1, 3],
    ]);
    expect(layout.links[0]).toMatchObject({ sourceName: "Pay", targetName: "A" });
    expect(layout.links[7]).toMatchObject({ sourceName: "Gig", targetName: REMAINING_LABEL });
  });

  it("runs every ribbon from its source bar to its target bar with no taper", () => {
    const layout = layoutDirectIncomeSankey(sources, spending, {
      width: 800,
      height: 400,
    });
    for (const link of layout.links) {
      const src = layout.sources[link.sourceIndex]!;
      const tgt = layout.targets[link.targetIndex]!;
      expect(link.x0).toBeCloseTo(src.x + src.w, 6);
      expect(link.x1).toBeCloseTo(tgt.x, 6);
      expect(link.x1).toBeGreaterThan(link.x0);
      // No taper: equal band height at both ends.
      expect(link.sy1 - link.sy0).toBeCloseTo(link.ty1 - link.ty0, 6);
      // Bands sit inside their bars.
      expect(link.sy0).toBeGreaterThanOrEqual(src.y - 1e-9);
      expect(link.sy1).toBeLessThanOrEqual(src.y + src.h + 1e-9);
      expect(link.ty0).toBeGreaterThanOrEqual(tgt.y - 1e-9);
      expect(link.ty1).toBeLessThanOrEqual(tgt.y + tgt.h + 1e-9);
      // Closed ribbon path running left-to-right.
      expect(link.d).toMatch(/^M .* C .* Z$/);
    }
    // Incoming bands exactly fill each target bar (fully funded here).
    for (let j = 0; j < layout.targets.length; j++) {
      const tgt = layout.targets[j]!;
      const bands = layout.links.filter((l) => l.targetIndex === j);
      const bandsH = bands.reduce((s, l) => s + (l.ty1 - l.ty0), 0);
      expect(bandsH).toBeCloseTo(tgt.h, 6);
      expect(bands[0]!.ty0).toBeCloseTo(tgt.y, 6);
      expect(tgt.unfundedH).toBe(0);
      expect(tgt.unfundedValue).toBe(0);
    }
  });

  it("stacks both columns top-down inside the padded plot area", () => {
    const W = 800;
    const H = 400;
    const layout = layoutDirectIncomeSankey(sources, spending, {
      width: W,
      height: H,
      padTop: 28,
      padBottom: 28,
    });
    expect(layout.sources[0]!.y).toBeCloseTo(28, 6);
    expect(layout.targets[0]!.y).toBeCloseTo(28, 6);
    for (const col of [layout.sources, layout.targets]) {
      let prevTop = 28;
      for (const node of col) {
        expect(node.y).toBeGreaterThanOrEqual(prevTop - 1e-9);
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.x + node.w).toBeLessThanOrEqual(W);
        expect(node.y + node.h).toBeLessThanOrEqual(H - 28 + 1e-9);
        prevTop = node.y + node.h;
      }
    }
    // Node shares match drawn heights on both sides.
    for (const node of [...layout.sources, ...layout.targets]) {
      expect(node.share).toBeCloseTo(node.value / layout.flowTotal, 9);
    }
  });

  it("renders the shortfall as an unfunded segment at each expense bar's bottom", () => {
    const layout = layoutDirectIncomeSankey([merged("Pay", 2500)], [merged("A", 6000)], {
      width: 800,
      height: 400,
    });
    expect(layout.targets).toHaveLength(1);
    const tgt = layout.targets[0]!;
    expect(tgt.fundedValue).toBeCloseTo(2500, 9);
    expect(tgt.unfundedValue).toBeCloseTo(3500, 9);
    // The unfunded segment takes the unfunded share of the bar at its bottom.
    expect(tgt.unfundedH).toBeCloseTo((tgt.h * 3500) / 6000, 6);
    expect(tgt.unfundedH).toBeGreaterThan(0);
    expect(tgt.unfundedH).toBeLessThan(tgt.h);
    // The single ribbon fills exactly the funded (top) region.
    expect(layout.links).toHaveLength(1);
    const link = layout.links[0]!;
    expect(link.ty0).toBeCloseTo(tgt.y, 6);
    expect(link.ty1).toBeCloseTo(tgt.y + tgt.h - tgt.unfundedH, 6);
  });

  it("renders fully-unfunded bars with no ribbons when there is no income", () => {
    const layout = layoutDirectIncomeSankey([], spending, { width: 800, height: 400 });
    expect(layout.sources).toEqual([]);
    expect(layout.targets).toHaveLength(3);
    expect(layout.links).toEqual([]);
    for (const tgt of layout.targets) {
      expect(tgt.fundedValue).toBe(0);
      expect(tgt.unfundedValue).toBe(tgt.value);
      expect(tgt.unfundedH).toBeCloseTo(tgt.h, 9);
      expect(Number.isFinite(tgt.y)).toBe(true);
      expect(Number.isFinite(tgt.h)).toBe(true);
    }
  });

  it("keeps label anchors clear of their bars", () => {
    const layout = layoutDirectIncomeSankey(sources, spending, {
      width: 800,
      height: 400,
      padLeft: 112,
    });
    expect(layout.sourceLabelX).toBeLessThanOrEqual(layout.sources[0]!.x - 8);
    expect(layout.targetLabelX).toBeGreaterThanOrEqual(
      layout.targets[0]!.x + layout.targets[0]!.w + 8
    );
  });

  it("reserves a left label zone clear of the viewport edge at any width", () => {
    // The view renders up to 20 name chars at ~7px plus an 11px amount line
    // into this zone, so it must hold that budget past the minimum inset.
    const MIN_LABEL_BUDGET = 20 * 7;
    for (const width of [800, 360]) {
      const layout = layoutDirectIncomeSankey(sources, spending, {
        width,
        height: 400,
        padLeft: SANKEY_SOURCE_GUTTER,
      });
      expect(layout.sourceLabelX).toBe(SANKEY_SOURCE_GUTTER - SANKEY_SOURCE_LABEL_GAP);
      expect(layout.sources[0]!.x).toBe(SANKEY_SOURCE_GUTTER);
      expect(layout.sourceLabelX - SANKEY_LEFT_LABEL_INSET).toBeGreaterThanOrEqual(
        MIN_LABEL_BUDGET
      );
      // Narrow widths squeeze the ribbons, never the labels or bars.
      for (const link of layout.links) {
        expect(link.x1).toBeGreaterThan(link.x0);
      }
    }
    // Degenerate layouts anchor the same way (the contract is unconditional).
    const empty = layoutDirectIncomeSankey([], [], {
      width: 800,
      height: 400,
      padLeft: SANKEY_SOURCE_GUTTER,
    });
    expect(empty.sourceLabelX).toBe(SANKEY_SOURCE_GUTTER - SANKEY_SOURCE_LABEL_GAP);
  });

  it("keeps every row pitch at the label minimum when sized by the view contract", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      merged(`M${i}`, Math.max(1, 60000 - i * 997))
    );
    const both = [merged("Pay", 300000), merged("Gig", 120000)];
    const height = sankeyContentHeight(
      Math.max(both.length, many.length + 1),
      400
    );
    const layout = layoutDirectIncomeSankey(both, many, {
      width: 800,
      height,
      padTop: SANKEY_PAD_TOP,
      padBottom: SANKEY_PAD_BOTTOM,
      nodeGap: SANKEY_NODE_GAP,
      minNodeHeight: SANKEY_NODE_MIN_HEIGHT,
    });
    // 60 expenses, no Remaining (spending exceeds income); 2 x 60 ribbons.
    expect(layout.targets).toHaveLength(60);
    expect(layout.links).toHaveLength(120);
    for (let i = 1; i < layout.targets.length; i++) {
      expect(layout.targets[i]!.y - layout.targets[i - 1]!.y).toBeGreaterThanOrEqual(
        SANKEY_MIN_PITCH - 1e-9
      );
    }
    const last = layout.targets[layout.targets.length - 1]!;
    expect(last.y + last.h).toBeLessThanOrEqual(height - SANKEY_PAD_BOTTOM + 1e-6);
    const lastSrc = layout.sources[layout.sources.length - 1]!;
    expect(lastSrc.y + lastSrc.h).toBeLessThanOrEqual(height - SANKEY_PAD_BOTTOM + 1e-6);
    for (const node of [...layout.sources, ...layout.targets]) {
      expect(Number.isFinite(node.y)).toBe(true);
      expect(Number.isFinite(node.h)).toBe(true);
    }
  });
});
