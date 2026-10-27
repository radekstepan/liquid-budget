import { describe, expect, it } from "vitest";
import {
  computeSpendingBreakdown,
  layoutSankey,
  mergeBelowThreshold,
  OTHER_BUCKET_LABEL,
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
});
