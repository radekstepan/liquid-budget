import { describe, expect, it } from "vitest";
import {
  computeDirectFlowLinks,
  computeIncomeBreakdown,
  computeSpendingBreakdown,
  computeSpendingGroupFlow,
  layoutDirectIncomeSankey,
  layoutGroupedIncomeSankey,
  layoutSankey,
  mergeBelowThreshold,
  mergeGroupFlow,
  OTHER_BUCKET_LABEL,
  OVER_INCOME_LABEL,
  REMAINING_LABEL,
  sankeyAutoFitThreshold,
  sankeyContentHeight,
  sankeyThresholdStep,
  sankeyThresholdStops,
  sortMergedGroupFlow,
  SANKEY_THRESHOLD_STOPS,
  SANKEY_SOURCE_AMOUNT_MIN_HEIGHT,
  showSankeySourceAmount,
  SANKEY_LEFT_LABEL_INSET,
  SANKEY_MIDDLE_LABEL_GAP,
  SANKEY_MIN_PITCH,
  SANKEY_NODE_GAP,
  SANKEY_NODE_MIN_HEIGHT,
  SANKEY_PAD_BOTTOM,
  SANKEY_PAD_TOP,
  SANKEY_SOURCE_GUTTER,
  SANKEY_SOURCE_LABEL_GAP,
  UNCATEGORIZED_GROUP_LABEL,
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
    // Internal same-boundary move: counted as spending (legacy semantics)
    // but not off-budget money, so no transfer flag.
    expect(items.every((i) => i.transfer === undefined)).toBe(true);
  });

  it("excludes credit-card payoff transfers in category mode (money flows through once)", () => {
    const data = makeData();
    data.accounts.push(
      { id: 3, name: "Visa", kind: "credit", groupLabel: "Credit", balance: "0", onBudget: true, sort: 2 }
    );
    data.transactions.push(
      // Original card purchase: the one true spending record.
      txn("2026-06-08", "Whole Foods", -20000, 10, { accountId: 3 }),
      // Payoff from income: flows through, must not double-count.
      txn("2026-06-15", "Transfer : Visa", -20000, null, { transferAccountId: 3 }),
      // Even a (mis)categorized payoff is movement, not spending.
      txn("2026-06-16", "Transfer : Visa", -5000, 10, { transferAccountId: 3 })
    );
    const items = computeSpendingBreakdown(data, "2026-06", "2026-06", "categories");
    expect(items).toEqual([{ name: "Groceries", value: 25000 }]);
  });

  it("excludes credit-card payoff transfers in merchant mode (no Transfer expense)", () => {
    const data = makeData();
    data.accounts.push(
      { id: 3, name: "Visa", kind: "credit", groupLabel: "Credit", balance: "0", onBudget: true, sort: 2 }
    );
    data.transactions.push(
      txn("2026-06-08", "Whole Foods", -20000, 10, { accountId: 3 }),
      txn("2026-06-15", "Transfer : Visa", -20000, null, { transferAccountId: 3 })
    );
    const items = computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants");
    expect(items).toEqual([{ name: "Whole Foods", value: 25000 }]);
    expect(items.some((i) => i.name.startsWith("Transfer"))).toBe(false);
  });

  it("keeps payments to off-budget (tracking) credit accounts as spending", () => {
    const data = makeData();
    data.accounts.push(
      { id: 4, name: "Tracking Loan", kind: "credit", groupLabel: "Loans", balance: "0", onBudget: false, sort: 3 }
    );
    // Boundary outflow: money really leaves the budget, and the loan's own
    // activity never hit budget categories, so there is nothing to double-count.
    data.transactions.push(
      txn("2026-06-15", "Transfer : Tracking Loan", -20000, 10, { transferAccountId: 4 })
    );
    const items = computeSpendingBreakdown(data, "2026-06", "2026-06", "categories");
    // The boundary outflow flags the row as transfer money.
    expect(items).toEqual([{ name: "Groceries", value: 25000, transfer: true }]);
  });

  it("counts investment contributions once and excludes the withdrawal from spending", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    data.transactions.push(
      txn("2026-06-10", "Transfer : Wealthsimple Trade", -30000, 10, { transferAccountId: 5 }),
      txn("2026-06-20", "Transfer : Wealthsimple Trade", 100000, 10, { transferAccountId: 5 })
    );
    // The contribution is the outflow allocation; the withdrawal is income, so
    // it must not net against spending here.
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([
      { name: "Groceries", value: 35000, transfer: true },
    ]);
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants")).toEqual([
      { name: "Transfer : Wealthsimple Trade", value: 30000, transfer: true },
      { name: "Whole Foods", value: 5000 },
    ]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(computeSpendingBreakdown(makeData(), "2020-01", "2020-02", "categories")).toEqual([]);
    expect(computeSpendingBreakdown(makeData(), "2020-01", "2020-02", "merchants")).toEqual([]);
  });
});

function makeFlowData(): BudgetData {
  const data = makeData();
  data.groups.push({ id: 2, name: "Bills", sort: 1, isCreditCardPayments: false });
  data.categories.push(
    { id: 12, groupId: 1, name: "Dining", sort: 2, carryover: "0", goalTarget: null, linkedAccountId: null },
    { id: 13, groupId: 2, name: "Electric", sort: 3, carryover: "0", goalTarget: null, linkedAccountId: null }
  );
  // Move Rent into Bills so the two groups both carry spending.
  data.categories.find((c) => c.id === 11)!.groupId = 2;
  return data;
}

describe("computeSpendingGroupFlow", () => {
  it("attributes each category to its group exactly in categories mode", () => {
    const flow = computeSpendingGroupFlow(makeFlowData(), "2026-04", "2026-06", "categories");
    expect(flow.targets).toEqual([
      { name: "Groceries", value: 35000 },
      { name: "Rent", value: 30000 },
    ]);
    expect(flow.groups).toEqual([
      { name: "Everyday", value: 35000 },
      { name: "Bills", value: 30000 },
    ]);
    expect(flow.links).toEqual([
      { groupIndex: 0, targetIndex: 0, value: 35000 },
      { groupIndex: 1, targetIndex: 1, value: 30000 },
    ]);
  });

  it("returns targets identical to computeSpendingBreakdown in both dimensions", () => {
    for (const dim of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(makeFlowData(), "2026-04", "2026-06", dim);
      expect(flow.targets).toEqual(computeSpendingBreakdown(makeFlowData(), "2026-04", "2026-06", dim));
      // Reversed bounds agree too (the swap lives in the shared loop).
      const rev = computeSpendingGroupFlow(makeFlowData(), "2026-06", "2026-04", dim);
      expect(rev.targets).toEqual(flow.targets);
      expect(rev.groups).toEqual(flow.groups);
      expect(rev.links).toEqual(flow.links);
    }
  });

  it("splits a merchant across its transactions' groups exactly in merchant mode", () => {
    const data = makeFlowData();
    // Whole Foods also sells electricity now: $80 in Bills on top of $350 in Everyday.
    data.transactions.push(txn("2026-06-10", "Whole Foods", -8000, 13));
    const flow = computeSpendingGroupFlow(data, "2026-04", "2026-06", "merchants");
    expect(flow.targets).toEqual([
      { name: "Whole Foods", value: 43000 },
      { name: "Landlord", value: 30000 },
      { name: "Corner Shop", value: 15000 },
    ]);
    expect(flow.groups).toEqual([
      { name: "Bills", value: 38000 },
      { name: "Everyday", value: 35000 },
      { name: UNCATEGORIZED_GROUP_LABEL, value: 15000 },
    ]);
    // Links sorted by (groupIndex, targetIndex).
    expect(flow.links).toEqual([
      { groupIndex: 0, targetIndex: 0, value: 8000 },
      { groupIndex: 0, targetIndex: 1, value: 30000 },
      { groupIndex: 1, targetIndex: 0, value: 35000 },
      { groupIndex: 2, targetIndex: 2, value: 15000 },
    ]);
  });

  it("routes uncategorized rows to the Uncategorized pseudo-group in merchant mode", () => {
    const flow = computeSpendingGroupFlow(makeFlowData(), "2026-04", "2026-06", "merchants");
    // Corner Shop ($150) is the only uncategorized spender in the fixture.
    expect(flow.groups).toContainEqual({ name: UNCATEGORIZED_GROUP_LABEL, value: 15000 });
    const cornerIdx = flow.targets.findIndex((t) => t.name === "Corner Shop");
    const cornerLinks = flow.links.filter((l) => l.targetIndex === cornerIdx);
    expect(cornerLinks).toHaveLength(1);
    expect(flow.groups[cornerLinks[0]!.groupIndex]!.name).toBe(UNCATEGORIZED_GROUP_LABEL);
  });

  it("spreads a net-negative group cell proportionally instead of drawing negative ribbons", () => {
    const data = makeFlowData();
    data.transactions.push(
      txn("2026-06-10", "Gadget Store", -10000, 10),
      // A refund bigger than nothing in Bills: the (Bills, Gadget Store)
      // cell nets to -$60 while the merchant nets to +$40 overall.
      txn("2026-06-11", "Gadget Store", 6000, 13)
    );
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "merchants");
    const gsIdx = flow.targets.findIndex((t) => t.name === "Gadget Store");
    expect(flow.targets[gsIdx]).toEqual({ name: "Gadget Store", value: 4000 });
    const gsLinks = flow.links.filter((l) => l.targetIndex === gsIdx);
    // Only the positive Everyday cell draws; the -$60 Bills cell is spread
    // (the $40 net attributes entirely to Everyday).
    expect(gsLinks).toHaveLength(1);
    expect(flow.groups[gsLinks[0]!.groupIndex]!.name).toBe("Everyday");
    expect(gsLinks[0]!.value).toBeCloseTo(4000, 9);
    for (const l of flow.links) {
      expect(l.value).toBeGreaterThan(0);
    }
  });

  it("falls back to an em-dash group for dangling categories", () => {
    const data = makeFlowData();
    data.categories.push(
      { id: 50, groupId: 99, name: "Orphan", sort: 9, carryover: "0", goalTarget: null, linkedAccountId: null }
    );
    data.transactions.push(
      txn("2026-06-10", "Mystery", -7000, 999),
      txn("2026-06-11", "Orphan Store", -3000, 50)
    );
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(flow.targets).toContainEqual({ name: "—", value: 7000 });
    expect(flow.targets).toContainEqual({ name: "Orphan", value: 3000 });
    // Both rows land in the em-dash group (unknown category / unknown group).
    expect(flow.groups).toContainEqual({ name: "—", value: 10000 });
  });

  it("conserves flow: link marginals match both columns", () => {
    const data = makeFlowData();
    data.transactions.push(txn("2026-06-10", "Whole Foods", -8000, 13));
    for (const dim of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, "2026-04", "2026-06", dim);
      for (let i = 0; i < flow.groups.length; i++) {
        const out = flow.links.filter((l) => l.groupIndex === i).reduce((s, l) => s + l.value, 0);
        expect(out).toBeCloseTo(flow.groups[i]!.value, 9);
      }
      for (let j = 0; j < flow.targets.length; j++) {
        const into = flow.links.filter((l) => l.targetIndex === j).reduce((s, l) => s + l.value, 0);
        expect(into).toBeCloseTo(flow.targets[j]!.value, 9);
        // Every kept target draws at least one ribbon.
        expect(flow.links.some((l) => l.targetIndex === j)).toBe(true);
      }
      // Both columns sum to the same spending total.
      const gSum = flow.groups.reduce((s, g) => s + g.value, 0);
      const tSum = flow.targets.reduce((s, t) => s + t.value, 0);
      expect(gSum).toBeCloseTo(tSum, 9);
    }
  });

  it("inherits every breakdown filter (payoffs, boundary inflows, splits)", () => {
    // Delegation keeps the filters identical by construction; one joint
    // probe proves the flow (not just the targets) honors them.
    const data = makeFlowData();
    data.accounts.push(
      { id: 3, name: "Visa", kind: "credit", groupLabel: "Credit", balance: "0", onBudget: true, sort: 2 },
      { id: 5, name: "Broker", kind: "offbudget", groupLabel: "Invest", balance: "0", onBudget: false, sort: 4 }
    );
    data.transactions.push(
      txn("2026-06-15", "Transfer : Visa", -20000, null, { transferAccountId: 3 }),
      txn("2026-06-16", "Transfer : Broker", 100000, 10, { transferAccountId: 5 }),
      txn("2026-06-10", "Split Store", -10000, null, { id: 900 }),
      txn("2026-06-10", "Split Store", -10000, 10, { id: 901, parentId: 900 })
    );
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    // Only the June Groceries rows count: $50 + the $100 split child.
    expect(flow.targets).toEqual([{ name: "Groceries", value: 15000 }]);
    expect(flow.groups).toEqual([{ name: "Everyday", value: 15000 }]);
    expect(flow.links).toEqual([{ groupIndex: 0, targetIndex: 0, value: 15000 }]);
  });

  it("returns an empty flow when nothing matches", () => {
    for (const dim of ["categories", "merchants"] as const) {
      expect(computeSpendingGroupFlow(makeFlowData(), "2020-01", "2020-02", dim)).toEqual({
        groups: [],
        targets: [],
        links: [],
      });
    }
  });
});

describe("mergeGroupFlow", () => {
  const groups = [
    { name: "Bills", value: 38000 },
    { name: "Everyday", value: 35000 },
    { name: UNCATEGORIZED_GROUP_LABEL, value: 15000 },
  ];
  const targets = [
    { name: "Whole Foods", value: 43000 },
    { name: "Landlord", value: 30000 },
    { name: "Corner Shop", value: 15000 },
  ];
  const links = [
    { groupIndex: 0, targetIndex: 0, value: 8000 },
    { groupIndex: 0, targetIndex: 1, value: 30000 },
    { groupIndex: 1, targetIndex: 0, value: 35000 },
    { groupIndex: 2, targetIndex: 2, value: 15000 },
  ];

  function expectConserved(
    merged: { groups: { value: number }[]; targets: { value: number }[]; links: { groupIndex: number; targetIndex: number; value: number }[] }
  ) {
    for (let i = 0; i < merged.groups.length; i++) {
      const out = merged.links.filter((l) => l.groupIndex === i).reduce((s, l) => s + l.value, 0);
      expect(out).toBeCloseTo(merged.groups[i]!.value, 9);
    }
    for (let j = 0; j < merged.targets.length; j++) {
      const into = merged.links.filter((l) => l.targetIndex === j).reduce((s, l) => s + l.value, 0);
      expect(into).toBeCloseTo(merged.targets[j]!.value, 9);
    }
  }

  it("passes everything through unchanged when the threshold is 0", () => {
    const merged = mergeGroupFlow(groups, targets, links, 0);
    expect(merged.groups).toEqual(groups.map((g) => ({ ...g, mergedCount: 1 })));
    expect(merged.targets).toEqual(targets.map((t) => ({ ...t, mergedCount: 1 })));
    expect(merged.links).toEqual(links);
    expect(merged.otherCount).toBe(0);
    expect(merged.otherValue).toBe(0);
  });

  it("merges both columns with mergeBelowThreshold semantics and re-aggregates links", () => {
    const merged = mergeGroupFlow(groups, targets, links, 20000);
    // Corner Shop ($150) and Uncategorized ($150) fold; the rest stay.
    expect(merged.targets).toEqual(mergeBelowThreshold(targets, 20000).items);
    expect(merged.groups).toEqual(mergeBelowThreshold(groups, 20000).items);
    expect(merged.targets).toEqual([
      { name: "Whole Foods", value: 43000, mergedCount: 1 },
      { name: "Landlord", value: 30000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 15000, mergedCount: 1, bucket: true },
    ]);
    expect(merged.groups).toEqual([
      { name: "Bills", value: 38000, mergedCount: 1 },
      { name: "Everyday", value: 35000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 15000, mergedCount: 1, bucket: true },
    ]);
    // The merged cell re-keys onto the two Other buckets.
    expect(merged.links).toEqual([
      { groupIndex: 0, targetIndex: 0, value: 8000 },
      { groupIndex: 0, targetIndex: 1, value: 30000 },
      { groupIndex: 1, targetIndex: 0, value: 35000 },
      { groupIndex: 2, targetIndex: 2, value: 15000 },
    ]);
    expect(merged.otherCount).toBe(2);
    expect(merged.otherValue).toBe(30000);
    expectConserved(merged);
  });

  it("routes a kept target through the middle Other when only its group merges", () => {
    const merged = mergeGroupFlow(
      [
        { name: "Big", value: 9000 },
        { name: "Small", value: 1000 },
      ],
      [{ name: "A", value: 10000 }],
      [
        { groupIndex: 0, targetIndex: 0, value: 9000 },
        { groupIndex: 1, targetIndex: 0, value: 1000 },
      ],
      5000
    );
    expect(merged.groups).toEqual([
      { name: "Big", value: 9000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 1000, mergedCount: 1, bucket: true },
    ]);
    expect(merged.targets).toEqual([{ name: "A", value: 10000, mergedCount: 1 }]);
    expect(merged.links).toEqual([
      { groupIndex: 0, targetIndex: 0, value: 9000 },
      { groupIndex: 1, targetIndex: 0, value: 1000 },
    ]);
    expect(merged.otherCount).toBe(1);
    expectConserved(merged);
  });

  it("fans a merged Other target out to every group that feeds it", () => {
    const merged = mergeGroupFlow(
      [{ name: "G", value: 10000 }],
      [
        { name: "A", value: 9000 },
        { name: "B", value: 1000 },
      ],
      [
        { groupIndex: 0, targetIndex: 0, value: 9000 },
        { groupIndex: 0, targetIndex: 1, value: 1000 },
      ],
      5000
    );
    expect(merged.targets).toEqual([
      { name: "A", value: 9000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 1000, mergedCount: 1, bucket: true },
    ]);
    expect(merged.links).toEqual([
      { groupIndex: 0, targetIndex: 0, value: 9000 },
      { groupIndex: 0, targetIndex: 1, value: 1000 },
    ]);
    expectConserved(merged);
  });

  it("keeps a literal Other name distinct from the merged bucket (index-keyed)", () => {
    const merged = mergeGroupFlow(
      [
        { name: OTHER_BUCKET_LABEL, value: 10000 },
        { name: "Dust", value: 100 },
      ],
      [{ name: "A", value: 10100 }],
      [
        { groupIndex: 0, targetIndex: 0, value: 10000 },
        { groupIndex: 1, targetIndex: 0, value: 100 },
      ],
      5000
    );
    // Two rows share the name but route by index: the kept group and the
    // merged bucket stay separate, and both marginals still hold.
    expect(merged.groups).toEqual([
      { name: OTHER_BUCKET_LABEL, value: 10000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 100, mergedCount: 1, bucket: true },
    ]);
    expect(merged.links).toEqual([
      { groupIndex: 0, targetIndex: 0, value: 10000 },
      { groupIndex: 1, targetIndex: 0, value: 100 },
    ]);
    expectConserved(merged);
  });

  it("drops dangling and non-positive links", () => {
    const merged = mergeGroupFlow(
      [{ name: "G", value: 10000 }],
      [{ name: "A", value: 10000 }],
      [
        { groupIndex: 0, targetIndex: 0, value: 10000 },
        { groupIndex: 9, targetIndex: 0, value: 500 },
        { groupIndex: 0, targetIndex: 9, value: 500 },
        { groupIndex: 0, targetIndex: 0, value: 0 },
        { groupIndex: -1, targetIndex: 0, value: 5 },
      ],
      0
    );
    expect(merged.links).toEqual([{ groupIndex: 0, targetIndex: 0, value: 10000 }]);
    expectConserved(merged);
  });

  it("returns empty output with no phantom Other for empty input", () => {
    const merged = mergeGroupFlow([], [], [], 5000);
    expect(merged.groups).toEqual([]);
    expect(merged.targets).toEqual([]);
    expect(merged.links).toEqual([]);
    expect(merged.otherCount).toBe(0);
    expect(merged.otherValue).toBe(0);
  });

  it("carries transfer flags through both columns into their Other buckets", () => {
    const merged = mergeGroupFlow(
      [
        { name: "Big", value: 9000 },
        { name: "Small", value: 1000 },
      ],
      [
        { name: "Kept", value: 9000 },
        { name: "Moved Out", value: 1000, transfer: true },
      ],
      [
        { groupIndex: 0, targetIndex: 0, value: 9000 },
        { groupIndex: 1, targetIndex: 1, value: 1000 },
      ],
      5000
    );
    // The flagged target folds, so the target Other bucket inherits the
    // flag; the group Other bucket holds a plain row and stays unflagged.
    expect(merged.targets).toEqual([
      { name: "Kept", value: 9000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 1000, mergedCount: 1, bucket: true, transfer: true },
    ]);
    expect(merged.groups).toEqual([
      { name: "Big", value: 9000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 1000, mergedCount: 1, bucket: true },
    ]);
    expectConserved(merged);
  });
});

describe("sortMergedGroupFlow", () => {
  function mrow(name: string, value: number): MergedSpendingItem {
    return { name, value, mergedCount: 1 };
  }

  const flow = {
    groups: [mrow("G-big", 6000), mrow("G-mid", 3000), mrow("G-small", 1000)],
    targets: [mrow("A", 5000), mrow("C", 3000), mrow("B", 1000), mrow("D", 1000)],
    links: [
      { groupIndex: 0, targetIndex: 0, value: 5000 },
      { groupIndex: 1, targetIndex: 1, value: 3000 },
      { groupIndex: 0, targetIndex: 2, value: 1000 },
      { groupIndex: 2, targetIndex: 3, value: 1000 },
    ],
    otherCount: 0,
    otherValue: 0,
  };

  it("passes the flow through unchanged in amount mode", () => {
    expect(sortMergedGroupFlow(flow, ["G-small", "G-big", "G-mid"], "amount")).toBe(flow);
  });

  it("orders both columns by Budget group order, value-descending within a group", () => {
    // Budget order reverses the amount order: G-small first, G-mid last.
    const sorted = sortMergedGroupFlow(flow, ["G-small", "G-big", "G-mid"], "group");
    expect(sorted.groups.map((g) => g.name)).toEqual(["G-small", "G-big", "G-mid"]);
    // Right column groups by dominant parent (D under G-small; A then B
    // under G-big by amount; C under G-mid).
    expect(sorted.targets.map((t) => t.name)).toEqual(["D", "A", "B", "C"]);
    // Links remap onto the new indices, still (group, target) sorted.
    expect(sorted.links).toEqual([
      { groupIndex: 0, targetIndex: 0, value: 1000 },
      { groupIndex: 1, targetIndex: 1, value: 5000 },
      { groupIndex: 1, targetIndex: 2, value: 1000 },
      { groupIndex: 2, targetIndex: 3, value: 3000 },
    ]);
    // Both marginals still hold: a permutation moves cells, never values.
    for (let i = 0; i < sorted.groups.length; i++) {
      const out = sorted.links
        .filter((l) => l.groupIndex === i)
        .reduce((s, l) => s + l.value, 0);
      expect(out).toBeCloseTo(sorted.groups[i]!.value, 9);
    }
    for (let j = 0; j < sorted.targets.length; j++) {
      const into = sorted.links
        .filter((l) => l.targetIndex === j)
        .reduce((s, l) => s + l.value, 0);
      expect(into).toBeCloseTo(sorted.targets[j]!.value, 9);
    }
    expect(sorted.otherCount).toBe(0);
    expect(sorted.otherValue).toBe(0);
  });

  it("attributes a split merchant to its dominant group and breaks ties deterministically", () => {
    const split = {
      groups: [mrow("First", 5000), mrow("Second", 5000)],
      targets: [mrow("Split", 4000), mrow("Tied", 2000), mrow("Plain", 4000)],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 3000 },
        { groupIndex: 1, targetIndex: 0, value: 1000 },
        { groupIndex: 0, targetIndex: 1, value: 1000 },
        { groupIndex: 1, targetIndex: 1, value: 1000 },
        { groupIndex: 1, targetIndex: 2, value: 4000 },
      ],
      otherCount: 0,
      otherValue: 0,
    };
    // Budget order puts Second first: Split still sorts under First (its
    // dominant $3000 link), Tied keeps the first link's group on the tie.
    const sorted = sortMergedGroupFlow(split, ["Second", "First"], "group");
    expect(sorted.groups.map((g) => g.name)).toEqual(["Second", "First"]);
    expect(sorted.targets.map((t) => t.name)).toEqual(["Plain", "Split", "Tied"]);
  });

  it("sorts unknown groups after known ones and keeps Other buckets last", () => {
    const mixed = {
      groups: [
        mrow("Known", 5000),
        mrow(UNCATEGORIZED_GROUP_LABEL, 4000),
        { name: OTHER_BUCKET_LABEL, value: 3000, mergedCount: 2, bucket: true as const },
      ],
      targets: [
        mrow("K", 5000),
        mrow("U", 4000),
        { name: OTHER_BUCKET_LABEL, value: 3000, mergedCount: 2, bucket: true as const },
      ],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 5000 },
        { groupIndex: 1, targetIndex: 1, value: 4000 },
        { groupIndex: 2, targetIndex: 2, value: 3000 },
      ],
      otherCount: 4,
      otherValue: 6000,
    };
    const sorted = sortMergedGroupFlow(mixed, ["Known"], "group");
    // The Uncategorized pseudo-group is not a Budget group, so it follows
    // the known groups; the render-only buckets stay last on both columns.
    expect(sorted.groups.map((g) => g.name)).toEqual([
      "Known",
      UNCATEGORIZED_GROUP_LABEL,
      OTHER_BUCKET_LABEL,
    ]);
    expect(sorted.targets.map((t) => t.name)).toEqual([
      "K",
      "U",
      OTHER_BUCKET_LABEL,
    ]);
    expect(sorted.otherCount).toBe(4);
    expect(sorted.otherValue).toBe(6000);
  });

  it("orders targets within a group by Budget category order", () => {
    // B ($1,000) trails A ($5,000) by amount, but Budget order lists it
    // first inside G-big.
    const sorted = sortMergedGroupFlow(flow, ["G-small", "G-big", "G-mid"], "group", [
      "B",
      "D",
      "C",
      "A",
    ]);
    expect(sorted.groups.map((g) => g.name)).toEqual(["G-small", "G-big", "G-mid"]);
    expect(sorted.targets.map((t) => t.name)).toEqual(["D", "B", "A", "C"]);
    // Links remap onto the new indices, still (group, target) sorted.
    expect(sorted.links).toEqual([
      { groupIndex: 0, targetIndex: 0, value: 1000 },
      { groupIndex: 1, targetIndex: 1, value: 1000 },
      { groupIndex: 1, targetIndex: 2, value: 5000 },
      { groupIndex: 2, targetIndex: 3, value: 3000 },
    ]);
  });

  it("sorts names missing from the category order after known ones, value-descending", () => {
    // Merchants have no Budget position: with no category order at all
    // the within-group order stays value-descending.
    const plain = sortMergedGroupFlow(flow, ["G-small", "G-big", "G-mid"], "group");
    expect(plain.targets.map((t) => t.name)).toEqual(["D", "A", "B", "C"]);
    // A known name leads its group even when a larger unknown follows.
    const mixed = sortMergedGroupFlow(flow, ["G-small", "G-big", "G-mid"], "group", ["B"]);
    expect(mixed.targets.map((t) => t.name)).toEqual(["D", "B", "A", "C"]);
  });

  it("sorts unlinked targets after grouped ones and handles empty flows", () => {
    const dangling = {
      groups: [mrow("G", 1000)],
      targets: [mrow("Linked", 1000), mrow("Stray", 500)],
      links: [{ groupIndex: 0, targetIndex: 0, value: 1000 }],
      otherCount: 0,
      otherValue: 0,
    };
    const sorted = sortMergedGroupFlow(dangling, ["G"], "group");
    expect(sorted.targets.map((t) => t.name)).toEqual(["Linked", "Stray"]);
    const empty = sortMergedGroupFlow(
      { groups: [], targets: [], links: [], otherCount: 0, otherValue: 0 },
      ["G"],
      "group"
    );
    expect(empty).toEqual({ groups: [], targets: [], links: [], otherCount: 0, otherValue: 0 });
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
      { name: OTHER_BUCKET_LABEL, value: 5200, mergedCount: 3, bucket: true },
    ]);
    expect(merged.otherCount).toBe(3);
    expect(merged.otherValue).toBe(5200);
  });

  it("flags even a single-row Other bucket so views never mistake it for a kept row", () => {
    const merged = mergeBelowThreshold(
      [
        { name: "Big", value: 10000 },
        { name: "Small", value: 1000 },
      ],
      5000
    );
    expect(merged.items).toEqual([
      { name: "Big", value: 10000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 1000, mergedCount: 1, bucket: true },
    ]);
    expect(merged.items[0]).not.toHaveProperty("bucket");
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
      { name: OTHER_BUCKET_LABEL, value: 15200, mergedCount: 4, bucket: true },
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

  it("keeps transfer flags on kept rows and folds them into the Other bucket", () => {
    const merged = mergeBelowThreshold(
      [
        { name: "Big", value: 10000, transfer: true },
        { name: "Mid", value: 4000 },
        { name: "Small", value: 1000, transfer: true },
      ],
      5000
    );
    expect(merged.items).toEqual([
      { name: "Big", value: 10000, mergedCount: 1, transfer: true },
      { name: OTHER_BUCKET_LABEL, value: 5000, mergedCount: 2, bucket: true, transfer: true },
    ]);
  });

  it("leaves the Other bucket unflagged when no folded row is a transfer", () => {
    const merged = mergeBelowThreshold(
      [
        { name: "Big", value: 10000, transfer: true },
        { name: "Small", value: 1000 },
      ],
      5000
    );
    expect(merged.items).toEqual([
      { name: "Big", value: 10000, mergedCount: 1, transfer: true },
      { name: OTHER_BUCKET_LABEL, value: 1000, mergedCount: 1, bucket: true },
    ]);
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

  it("counts investment withdrawals back into the budget as income, categorized or not", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    data.transactions.push(
      txn("2026-06-10", "Transfer : Wealthsimple Trade", 100000, 10, { transferAccountId: 5 }),
      txn("2026-06-11", "Transfer : Wealthsimple Trade", 50000, null, { transferAccountId: 5 })
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "Transfer : Wealthsimple Trade", value: 150000, transfer: true },
    ]);
  });

  it("counts withdrawals recorded on the off-budget leg at their budget value", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    // Same withdrawal, recorded on the investment account side: the amount is
    // negative there, but the budget impact (+75000) is the income.
    data.transactions.push(
      txn("2026-06-12", "Transfer : Chequing", -75000, null, { accountId: 5, transferAccountId: 1 })
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "Transfer : Chequing", value: 75000, transfer: true },
    ]);
  });

  it("flags only the withdrawal source when plain income mixes with transfers", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    data.transactions.push(
      txn("2026-06-10", "Transfer : Wealthsimple Trade", 100000, 10, { transferAccountId: 5 }),
      txn("2026-06-11", "Bonus", 20000, null)
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "Transfer : Wealthsimple Trade", value: 100000, transfer: true },
      { name: "Bonus", value: 20000 },
    ]);
  });

  it("does not count investment contributions as income", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    data.transactions.push(
      txn("2026-06-10", "Transfer : Wealthsimple Trade", -30000, 10, { transferAccountId: 5 })
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([]);
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

describe("layoutGroupedIncomeSankey", () => {
  const gSources = [merged("Pay", 8000), merged("Gig", 2000)];
  const gGroups = [merged("G1", 6000), merged("G2", 4000)];
  const gTargets = [merged("A", 5000), merged("B", 3000), merged("C", 2000)];
  const gLinks = [
    { groupIndex: 0, targetIndex: 0, value: 5000 },
    { groupIndex: 0, targetIndex: 1, value: 1000 },
    { groupIndex: 1, targetIndex: 1, value: 2000 },
    { groupIndex: 1, targetIndex: 2, value: 2000 },
  ];

  it("returns an empty layout with finite anchors for empty input (no NaN)", () => {
    const layout = layoutGroupedIncomeSankey([], [], [], [], { width: 800, height: 400 });
    expect(layout.flowTotal).toBe(0);
    expect(layout.sources).toEqual([]);
    expect(layout.middles).toEqual([]);
    expect(layout.targets).toEqual([]);
    expect(layout.remainingTargetIndex).toBeNull();
    expect(layout.linksLeft).toEqual([]);
    expect(layout.linksRight).toEqual([]);
    for (const v of [
      layout.incomeTotal,
      layout.spendingTotal,
      layout.flowTotal,
      layout.sourceLabelX,
      layout.middleLabelX,
      layout.targetLabelX,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("returns degenerate geometry for zero flow, bad dimensions, and absurd node widths", () => {
    // Targets without groups carry no flow (groups always derive from
    // targets in well-formed flows): flowTotal is 0, so the layout is empty.
    const zeroFlow = layoutGroupedIncomeSankey([], [], [merged("X", 5000)], [], {
      width: 800,
      height: 400,
    });
    expect(zeroFlow.flowTotal).toBe(0);
    expect(zeroFlow.targets).toEqual([]);
    expect(zeroFlow.linksRight).toEqual([]);
    for (const layout of [
      layoutGroupedIncomeSankey(gSources, gGroups, gTargets, gLinks, { width: 0, height: 400 }),
      layoutGroupedIncomeSankey(gSources, gGroups, gTargets, gLinks, { width: 800, height: 0 }),
      // The middle clamp degrades to a fixed offset instead of NaN.
      layoutGroupedIncomeSankey(gSources, gGroups, gTargets, gLinks, {
        width: 800,
        height: 400,
        nodeWidth: 500,
      }),
    ]) {
      for (const node of [...layout.sources, ...layout.middles, ...layout.targets]) {
        expect(Number.isFinite(node.x)).toBe(true);
        expect(Number.isFinite(node.y)).toBe(true);
        expect(Number.isFinite(node.h)).toBe(true);
      }
      for (const link of [...layout.linksLeft, ...layout.linksRight]) {
        expect(Number.isFinite(link.x0)).toBe(true);
        expect(Number.isFinite(link.x1)).toBe(true);
      }
      expect(Number.isFinite(layout.middleLabelX)).toBe(true);
    }
  });

  it("drops non-positive rows and their links, staying finite", () => {
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 6000)],
      [merged("G1", 6000), merged("Zero", 0)],
      [merged("A", 5000), merged("Neg", -100)],
      [
        { groupIndex: 0, targetIndex: 0, value: 5000 },
        { groupIndex: 1, targetIndex: 0, value: 999 },
        { groupIndex: 0, targetIndex: 1, value: 999 },
      ],
      { width: 800, height: 400 }
    );
    expect(layout.middles.map((m) => m.name)).toEqual(["G1"]);
    expect(layout.targets.map((t) => t.name)).toEqual(["A"]);
    expect(layout.remainingTargetIndex).toBeNull();
    expect(layout.linksRight).toHaveLength(1);
    expect(layout.linksRight[0]).toMatchObject({
      sourceIndex: 0,
      targetIndex: 0,
      value: 5000,
    });
    for (const node of [...layout.sources, ...layout.middles, ...layout.targets]) {
      expect(Number.isFinite(node.y)).toBe(true);
      expect(Number.isFinite(node.h)).toBe(true);
    }
  });

  it("routes income through groups into spending with no Remaining when balanced", () => {
    const layout = layoutGroupedIncomeSankey(gSources, gGroups, gTargets, gLinks, {
      width: 800,
      height: 400,
    });
    expect(layout.incomeTotal).toBe(10000);
    expect(layout.spendingTotal).toBe(10000);
    expect(layout.flowTotal).toBe(10000);
    expect(layout.sources).toHaveLength(2);
    expect(layout.middles.map((m) => m.name)).toEqual(["G1", "G2"]);
    expect(layout.targets).toHaveLength(3);
    // Left hop is dense (2 sources x 2 middles, middle-major); the right
    // hop draws ONE ribbon per exact rollup cell (middle, target order) —
    // no per-income subdivision, so no split lines inside a cell.
    expect(layout.linksLeft.map((l) => [l.sourceIndex, l.targetIndex])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(layout.linksRight.map((l) => [l.sourceIndex, l.targetIndex])).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 2],
    ]);
    const cellValue = new Map(gLinks.map((l) => [`${l.groupIndex}:${l.targetIndex}`, l.value]));
    for (const l of layout.linksRight) {
      const cell = cellValue.get(`${l.sourceIndex}:${l.targetIndex}`)!;
      expect(l.value).toBeCloseTo(cell, 9);
    }
    expect(layout.linksLeft[0]).toMatchObject({ sourceName: "Pay", targetName: "G1" });
    expect(layout.linksRight[0]).toMatchObject({
      sourceName: "G1",
      targetName: "A",
      value: 5000,
    });
  });

  it("appends Remaining as a trailing target fed directly from income, bypassing groups", () => {
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 12000)],
      gGroups,
      gTargets,
      gLinks,
      { width: 800, height: 400 }
    );
    expect(layout.middles.map((m) => m.name)).toEqual(["G1", "G2"]);
    expect(layout.targets.map((t) => t.name)).toEqual(["A", "B", "C", REMAINING_LABEL]);
    expect(layout.remainingTargetIndex).toBe(3);
    const rem = layout.targets[3]!;
    expect(rem).toMatchObject({ value: 2000, fundedValue: 2000, unfundedValue: 0 });
    // Every group draws an income ribbon, plus one ribbon into Remaining;
    // the right hop only routes groups into spending targets.
    expect(layout.linksLeft).toHaveLength(3);
    expect(layout.linksRight).toHaveLength(4);
    expect(layout.linksRight.every((l) => l.targetIndex < 3)).toBe(true);
    // The plug ribbon carries the plug index (one past the last middle).
    const plug = layout.linksLeft[2]!;
    expect(plug).toMatchObject({ sourceIndex: 0, targetIndex: 2, value: 2000 });
    expect(plug.targetName).toBe(REMAINING_LABEL);
    // Full-width: runs from the source bar to the Remaining bar, crossing
    // behind the middle column — and fills the plug bar exactly, no taper.
    expect(plug.x0).toBeCloseTo(layout.sources[0]!.x + layout.sources[0]!.w, 6);
    expect(plug.x1).toBeCloseTo(rem.x, 6);
    expect(plug.x1).toBeGreaterThan(layout.middles[0]!.x + layout.middles[0]!.w);
    expect(plug.sy1 - plug.sy0).toBeCloseTo(plug.ty1 - plug.ty0, 6);
    expect(plug.ty0).toBeCloseTo(rem.y, 6);
    expect(plug.ty1).toBeCloseTo(rem.y + rem.h, 6);
    expect(plug.d).toMatch(/^M .* C .* Z$/);
  });

  it("never mistakes a literal Remaining group for the surplus plug", () => {
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 12000)],
      [merged(REMAINING_LABEL, 6000), merged("G2", 4000)],
      gTargets,
      gLinks,
      { width: 800, height: 400 }
    );
    // The literal group stays in the middle; the plug is identified by
    // position (one past the last middle), never by name.
    expect(layout.middles.map((m) => m.name)).toEqual([REMAINING_LABEL, "G2"]);
    expect(layout.remainingTargetIndex).toBe(3);
    expect(layout.targets[3]).toMatchObject({ name: REMAINING_LABEL, value: 2000 });
    const plugLinks = layout.linksLeft.filter((l) => l.targetIndex === 2);
    expect(plugLinks).toHaveLength(1);
    expect(plugLinks[0]!.x1).toBeCloseTo(layout.targets[3]!.x, 6);
  });

  it("conserves each source across groups and Remaining under a surplus", () => {
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 9000), merged("Gig", 3000)],
      gGroups,
      gTargets,
      gLinks,
      { width: 800, height: 400 }
    );
    expect(layout.remainingTargetIndex).toBe(3);
    for (let i = 0; i < layout.sources.length; i++) {
      const out = layout.linksLeft
        .filter((l) => l.sourceIndex === i)
        .reduce((s, l) => s + l.value, 0);
      expect(out).toBeCloseTo(layout.sources[i]!.value, 9);
    }
    // The Remaining bands fill the plug bar exactly, in source order.
    const rem = layout.targets[3]!;
    const bands = layout.linksLeft.filter((l) => l.targetIndex === 2);
    expect(bands).toHaveLength(2);
    expect(bands.reduce((s, l) => s + (l.ty1 - l.ty0), 0)).toBeCloseTo(rem.h, 6);
    expect(bands[0]!.ty0).toBeCloseTo(rem.y, 6);
  });

  it("conserves value on both hops", () => {
    const layout = layoutGroupedIncomeSankey(gSources, gGroups, gTargets, gLinks, {
      width: 800,
      height: 400,
    });
    for (let i = 0; i < layout.sources.length; i++) {
      const out = layout.linksLeft
        .filter((l) => l.sourceIndex === i)
        .reduce((s, l) => s + l.value, 0);
      expect(out).toBeCloseTo(layout.sources[i]!.value, 9);
    }
    for (let i = 0; i < layout.middles.length; i++) {
      const into = layout.linksLeft
        .filter((l) => l.targetIndex === i)
        .reduce((s, l) => s + l.value, 0);
      const out = layout.linksRight
        .filter((l) => l.sourceIndex === i)
        .reduce((s, l) => s + l.value, 0);
      expect(into).toBeCloseTo(layout.middles[i]!.fundedValue, 9);
      expect(out).toBeCloseTo(layout.middles[i]!.fundedValue, 9);
      expect(layout.middles[i]!.fundedValue + layout.middles[i]!.unfundedValue).toBeCloseTo(
        layout.middles[i]!.value,
        9
      );
    }
    for (let j = 0; j < layout.targets.length; j++) {
      const into = layout.linksRight
        .filter((l) => l.targetIndex === j)
        .reduce((s, l) => s + l.value, 0);
      expect(into).toBeCloseTo(layout.targets[j]!.fundedValue, 9);
      expect(layout.targets[j]!.fundedValue + layout.targets[j]!.unfundedValue).toBeCloseTo(
        layout.targets[j]!.value,
        9
      );
    }
  });

  it("emits one ribbon per group→target cell carrying the full cell value", () => {
    const layout = layoutGroupedIncomeSankey(gSources, gGroups, gTargets, gLinks, {
      width: 800,
      height: 400,
    });
    // One link per exact rollup cell (never one per income): hovering a
    // group or target spotlights whole cells, and no split lines divide
    // what one line should show.
    expect(layout.linksRight).toHaveLength(gLinks.length);
    for (const cell of gLinks) {
      const ribbons = layout.linksRight.filter(
        (l) => l.sourceIndex === cell.groupIndex && l.targetIndex === cell.targetIndex
      );
      expect(ribbons).toHaveLength(1);
      expect(ribbons[0]!.value).toBeCloseTo(cell.value, 9);
      // No taper on the single band.
      expect(ribbons[0]!.sy1 - ribbons[0]!.sy0).toBeCloseTo(
        ribbons[0]!.ty1 - ribbons[0]!.ty0,
        6
      );
    }
    // Bands tile each middle's funded region contiguously in target order.
    for (let i = 0; i < layout.middles.length; i++) {
      const out = layout.linksRight.filter((l) => l.sourceIndex === i);
      const targets = out.map((l) => l.targetIndex);
      expect(targets).toEqual([...targets].sort((a, b) => a - b));
      for (let k = 1; k < out.length; k++) {
        expect(out[k]!.sy0).toBeCloseTo(out[k - 1]!.sy1, 6);
      }
    }
  });

  it("runs every ribbon bar-to-bar with no taper and closed paths", () => {
    const layout = layoutGroupedIncomeSankey(gSources, gGroups, gTargets, gLinks, {
      width: 800,
      height: 400,
    });
    for (const link of layout.linksLeft) {
      const src = layout.sources[link.sourceIndex]!;
      const mid = layout.middles[link.targetIndex]!;
      expect(link.x0).toBeCloseTo(src.x + src.w, 6);
      expect(link.x1).toBeCloseTo(mid.x, 6);
      expect(link.x1).toBeGreaterThan(link.x0);
      expect(link.sy1 - link.sy0).toBeCloseTo(link.ty1 - link.ty0, 6);
      expect(link.sy0).toBeGreaterThanOrEqual(src.y - 1e-9);
      expect(link.sy1).toBeLessThanOrEqual(src.y + src.h + 1e-9);
      expect(link.ty0).toBeGreaterThanOrEqual(mid.y - 1e-9);
      expect(link.ty1).toBeLessThanOrEqual(mid.y + mid.h + 1e-9);
      expect(link.d).toMatch(/^M .* C .* Z$/);
    }
    for (const link of layout.linksRight) {
      const mid = layout.middles[link.sourceIndex]!;
      const tgt = layout.targets[link.targetIndex]!;
      expect(link.x0).toBeCloseTo(mid.x + mid.w, 6);
      expect(link.x1).toBeCloseTo(tgt.x, 6);
      expect(link.x1).toBeGreaterThan(link.x0);
      expect(link.sy1 - link.sy0).toBeCloseTo(link.ty1 - link.ty0, 6);
      expect(link.sy0).toBeGreaterThanOrEqual(mid.y - 1e-9);
      expect(link.sy1).toBeLessThanOrEqual(mid.y + mid.h + 1e-9);
      expect(link.ty0).toBeGreaterThanOrEqual(tgt.y - 1e-9);
      expect(link.ty1).toBeLessThanOrEqual(tgt.y + tgt.h + 1e-9);
      expect(link.d).toMatch(/^M .* C .* Z$/);
    }
  });

  it("fills each middle funded region exactly from both sides, in order", () => {
    const layout = layoutGroupedIncomeSankey(gSources, gGroups, gTargets, gLinks, {
      width: 800,
      height: 400,
    });
    for (let i = 0; i < layout.middles.length; i++) {
      const mid = layout.middles[i]!;
      const inBands = layout.linksLeft.filter((l) => l.targetIndex === i);
      const outBands = layout.linksRight.filter((l) => l.sourceIndex === i);
      const inH = inBands.reduce((s, l) => s + (l.ty1 - l.ty0), 0);
      const outH = outBands.reduce((s, l) => s + (l.sy1 - l.sy0), 0);
      // Fully funded here: bands fill the whole bar from both sides.
      expect(inH).toBeCloseTo(mid.h, 6);
      expect(outH).toBeCloseTo(mid.h, 6);
      expect(inBands[0]!.ty0).toBeCloseTo(mid.y, 6);
      expect(outBands[0]!.sy0).toBeCloseTo(mid.y, 6);
      // Bands run in source order on the way in, target order on the way
      // out — one band per cell, no subdivision.
      expect(inBands.map((l) => l.sourceIndex)).toEqual([0, 1]);
      const outs = outBands.map((l) => l.targetIndex);
      expect(outs).toEqual([...outs].sort((a, b) => a - b));
      expect(new Set(outs).size).toBe(outs.length);
      expect(mid.unfundedH).toBe(0);
    }
    // Bands within a target run in middle order: B draws from G1 and then
    // G2, one contiguous band each.
    const intoB = layout.linksRight.filter((l) => l.targetIndex === 1);
    expect(intoB.map((l) => l.sourceIndex)).toEqual([0, 1]);
    for (let k = 1; k < intoB.length; k++) {
      expect(intoB[k]!.ty0).toBeCloseTo(intoB[k - 1]!.ty1, 6);
    }
  });

  it("stacks all three columns top-down inside the padded plot area", () => {
    const W = 800;
    const H = 400;
    const layout = layoutGroupedIncomeSankey(gSources, gGroups, gTargets, gLinks, {
      width: W,
      height: H,
      padTop: 28,
      padBottom: 28,
    });
    expect(layout.sources[0]!.y).toBeCloseTo(28, 6);
    expect(layout.middles[0]!.y).toBeCloseTo(28, 6);
    expect(layout.targets[0]!.y).toBeCloseTo(28, 6);
    for (const col of [layout.sources, layout.middles, layout.targets]) {
      let prevTop = 28;
      for (const node of col) {
        expect(node.y).toBeGreaterThanOrEqual(prevTop - 1e-9);
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.x + node.w).toBeLessThanOrEqual(W);
        expect(node.y + node.h).toBeLessThanOrEqual(H - 28 + 1e-9);
        prevTop = node.y + node.h;
      }
    }
    // The middle column sits strictly between the outer columns.
    const srcR = layout.sources[0]!.x + layout.sources[0]!.w;
    expect(layout.middles[0]!.x).toBeGreaterThan(srcR);
    expect(layout.middles[0]!.x + layout.middles[0]!.w).toBeLessThan(layout.targets[0]!.x);
    // Node shares match drawn heights on all three sides.
    for (const node of [...layout.sources, ...layout.middles, ...layout.targets]) {
      expect(node.share).toBeCloseTo(node.value / layout.flowTotal, 9);
    }
  });

  it("sizes bars to their funded flow with no unfunded segment under a shortfall", () => {
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 5000)],
      gGroups,
      gTargets,
      gLinks,
      { width: 800, height: 400 }
    );
    // $5000 income over $10000 spending: uniform half coverage, no Remaining.
    expect(layout.middles.map((m) => m.name)).toEqual(["G1", "G2"]);
    for (const mid of layout.middles) {
      // The cents split survives for tooltips, but the geometry carries no
      // unfunded segment: the bar wraps its funded bands exactly.
      expect(mid.fundedValue).toBeCloseTo(mid.value / 2, 9);
      expect(mid.unfundedValue).toBeCloseTo(mid.value / 2, 9);
      expect(mid.unfundedH).toBe(0);
      const inBands = layout.linksLeft.filter((l) => l.targetIndex === layout.middles.indexOf(mid));
      const inH = inBands.reduce((s, l) => s + (l.ty1 - l.ty0), 0);
      expect(inH).toBeCloseTo(mid.h, 6);
      expect(inBands[0]!.ty0).toBeCloseTo(mid.y, 6);
      const outBands = layout.linksRight.filter(
        (l) => l.sourceIndex === layout.middles.indexOf(mid)
      );
      const outH = outBands.reduce((s, l) => s + (l.sy1 - l.sy0), 0);
      expect(outH).toBeCloseTo(mid.h, 6);
    }
    for (const tgt of layout.targets) {
      expect(tgt.fundedValue).toBeCloseTo(tgt.value / 2, 9);
      expect(tgt.unfundedValue).toBeCloseTo(tgt.value / 2, 9);
      expect(tgt.unfundedH).toBe(0);
      const inBands = layout.linksRight.filter(
        (l) => l.targetIndex === layout.targets.indexOf(tgt)
      );
      const inH = inBands.reduce((s, l) => s + (l.ty1 - l.ty0), 0);
      expect(inH).toBeCloseTo(tgt.h, 6);
      expect(inBands[0]!.ty0).toBeCloseTo(tgt.y, 6);
    }
    // Half coverage on a 372px band over a $10000 flow: bars are exactly
    // their funded share (2500 → 93px, 1500 → 55.8px, 1000 → 37.2px).
    const heights = layout.targets.map((t) => t.h);
    expect(heights).toHaveLength(3);
    expect(heights[0]).toBeCloseTo(93, 6);
    expect(heights[1]).toBeCloseTo(55.8, 6);
    expect(heights[2]).toBeCloseTo(37.2, 6);
    // Right ribbons carry the exact cells at half coverage.
    expect(layout.linksRight.map((l) => l.value)).toEqual([2500, 500, 1000, 1000]);
  });

  it("floors tiny shortfall bars at the minimum label height with bands filling each bar", () => {
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 5000)],
      [merged("G", 10000)],
      [merged("A", 9900), merged("B", 100)],
      [
        { groupIndex: 0, targetIndex: 0, value: 9900 },
        { groupIndex: 0, targetIndex: 1, value: 100 },
      ],
      { width: 800, height: 400, minNodeHeight: 24 }
    );
    // B's funded flow ($50 of $10000 over a 378px band) is under 2px, so
    // the minimum lifts it to a legible bar; A keeps its flow height.
    const [a, b] = [layout.targets[0]!, layout.targets[1]!];
    expect(b.h).toBe(24);
    expect(a.h).toBeCloseTo((4950 / 10000) * 378, 6);
    // Bands still fill each bar exactly — the bar matches its ribbon stack.
    for (const tgt of layout.targets) {
      const inH = layout.linksRight
        .filter((l) => l.targetIndex === layout.targets.indexOf(tgt))
        .reduce((s, l) => s + (l.ty1 - l.ty0), 0);
      expect(inH).toBeCloseTo(tgt.h, 6);
      expect(tgt.unfundedH).toBe(0);
    }
  });

  it("funds minimums from the largest bars when minimums plus near-full flows overflow", () => {
    // Near-full coverage (99%) with a long tiny tail: minimums plus flows
    // exceed the band, so the largest bar gives up height to keep every
    // row at the label minimum.
    const targets = [merged("Big", 9100)];
    for (let i = 0; i < 9; i++) targets.push(merged(`T${i}`, 100));
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 9900)],
      [merged("G", 10000)],
      targets,
      targets.map((t, j) => ({ groupIndex: 0, targetIndex: j, value: t.value })),
      { width: 800, height: 400, minNodeHeight: 24 }
    );
    // Every row keeps the minimum; the tail sits exactly on it.
    for (const tgt of layout.targets) {
      expect(tgt.h).toBeGreaterThanOrEqual(24 - 1e-9);
    }
    expect(layout.targets.slice(1).every((t) => Math.abs(t.h - 24) < 1e-9)).toBe(true);
    // The donor shrank below its absolute flow height to fund the minimums.
    const bandH = 400 - 8 - 8 - 6 * (10 - 1);
    expect(layout.targets[0]!.h).toBeLessThan(((9100 * 0.99) / 10000) * bandH);
    // Bands fill each bar exactly and the column still fits the plot.
    for (const tgt of layout.targets) {
      const inH = layout.linksRight
        .filter((l) => l.targetIndex === layout.targets.indexOf(tgt))
        .reduce((s, l) => s + (l.ty1 - l.ty0), 0);
      expect(inH).toBeCloseTo(tgt.h, 6);
    }
    const last = layout.targets[layout.targets.length - 1]!;
    expect(last.y + last.h).toBeLessThanOrEqual(400 - 8 + 1e-6);
  });

  it("renders minimum-height bars with no ribbons when there is no income", () => {
    const layout = layoutGroupedIncomeSankey([], gGroups, gTargets, gLinks, {
      width: 800,
      height: 400,
    });
    expect(layout.sources).toEqual([]);
    expect(layout.linksLeft).toEqual([]);
    expect(layout.linksRight).toEqual([]);
    // Zero flow renders at the minimum label height (the default 8px here):
    // uniform bars with no unfunded segment and no ribbons.
    for (const mid of layout.middles) {
      expect(mid.fundedValue).toBe(0);
      expect(mid.unfundedValue).toBe(mid.value);
      expect(mid.unfundedH).toBe(0);
      expect(mid.h).toBe(8);
      expect(Number.isFinite(mid.y)).toBe(true);
    }
    for (const tgt of layout.targets) {
      expect(tgt.fundedValue).toBe(0);
      expect(tgt.unfundedValue).toBe(tgt.value);
      expect(tgt.unfundedH).toBe(0);
      expect(tgt.h).toBe(8);
      expect(Number.isFinite(tgt.y)).toBe(true);
    }
  });

  it("routes all income to a lone Remaining target when there is no spending", () => {
    const layout = layoutGroupedIncomeSankey([merged("Pay", 10000)], [], [], [], {
      width: 800,
      height: 400,
    });
    expect(layout.middles).toEqual([]);
    expect(layout.targets.map((t) => t.name)).toEqual([REMAINING_LABEL]);
    expect(layout.remainingTargetIndex).toBe(0);
    expect(layout.linksRight).toEqual([]);
    expect(layout.linksLeft).toHaveLength(1);
    expect(layout.linksLeft[0]).toMatchObject({ sourceIndex: 0, targetIndex: 0, value: 10000 });
    // Full-width ribbon into the lone plug.
    expect(layout.linksLeft[0]!.x1).toBeCloseTo(layout.targets[0]!.x, 6);
  });

  it("keeps label anchors clear of their bars on all three columns", () => {
    const layout = layoutGroupedIncomeSankey(gSources, gGroups, gTargets, gLinks, {
      width: 800,
      height: 400,
      padLeft: 112,
    });
    expect(layout.sourceLabelX).toBeLessThanOrEqual(layout.sources[0]!.x - 8);
    expect(layout.middleLabelX).toBe(
      layout.middles[0]!.x + layout.middles[0]!.w + SANKEY_MIDDLE_LABEL_GAP
    );
    expect(layout.targetLabelX).toBeGreaterThanOrEqual(
      layout.targets[0]!.x + layout.targets[0]!.w + 8
    );
  });

  it("reserves a left label zone clear of the viewport edge at any width", () => {
    // The view renders up to 20 name chars at ~7px plus an 11px amount line
    // into this zone, so it must hold that budget past the minimum inset.
    const MIN_LABEL_BUDGET = 20 * 7;
    for (const width of [800, 360]) {
      const layout = layoutGroupedIncomeSankey(gSources, gGroups, gTargets, gLinks, {
        width,
        height: 400,
        padLeft: SANKEY_SOURCE_GUTTER,
      });
      expect(layout.sourceLabelX).toBe(SANKEY_SOURCE_GUTTER - SANKEY_SOURCE_LABEL_GAP);
      expect(layout.sources[0]!.x).toBe(SANKEY_SOURCE_GUTTER);
      expect(layout.sourceLabelX - SANKEY_LEFT_LABEL_INSET).toBeGreaterThanOrEqual(
        MIN_LABEL_BUDGET
      );
      // Narrow widths squeeze the ribbons, never the labels or bars: both
      // runs stay positive.
      for (const link of [...layout.linksLeft, ...layout.linksRight]) {
        expect(link.x1).toBeGreaterThan(link.x0);
      }
    }
    // Degenerate layouts anchor the same way (the contract is unconditional).
    const empty = layoutGroupedIncomeSankey([], [], [], [], {
      width: 800,
      height: 400,
      padLeft: SANKEY_SOURCE_GUTTER,
    });
    expect(empty.sourceLabelX).toBe(SANKEY_SOURCE_GUTTER - SANKEY_SOURCE_LABEL_GAP);
    expect(Number.isFinite(empty.middleLabelX)).toBe(true);
  });

  it("keeps every row pitch at the label minimum when sized by the view contract", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      merged(`M${i}`, Math.max(1, 60000 - i * 997))
    );
    const triLinks = many.map((m, j) => ({ groupIndex: j % 3, targetIndex: j, value: m.value }));
    // Groups derived from their links, exactly like computeSpendingGroupFlow.
    const triGroups = [0, 1, 2].map((g) =>
      merged(
        `G${g + 1}`,
        triLinks.filter((l) => l.groupIndex === g).reduce((s, l) => s + l.value, 0)
      )
    );
    const both = [merged("Pay", 300000), merged("Gig", 120000)];
    const height = sankeyContentHeight(Math.max(both.length, triGroups.length, many.length), 400);
    const layout = layoutGroupedIncomeSankey(both, triGroups, many, triLinks, {
      width: 800,
      height,
      padTop: SANKEY_PAD_TOP,
      padBottom: SANKEY_PAD_BOTTOM,
      nodeGap: SANKEY_NODE_GAP,
      minNodeHeight: SANKEY_NODE_MIN_HEIGHT,
    });
    // 60 targets, no Remaining (spending exceeds income); 2 x 3 left
    // ribbons and one right ribbon per cell (60).
    expect(layout.targets).toHaveLength(60);
    expect(layout.middles).toHaveLength(3);
    expect(layout.linksLeft).toHaveLength(6);
    expect(layout.linksRight).toHaveLength(60);
    for (let i = 1; i < layout.targets.length; i++) {
      expect(layout.targets[i]!.y - layout.targets[i - 1]!.y).toBeGreaterThanOrEqual(
        SANKEY_MIN_PITCH - 1e-9
      );
    }
    const last = layout.targets[layout.targets.length - 1]!;
    expect(last.y + last.h).toBeLessThanOrEqual(height - SANKEY_PAD_BOTTOM + 1e-6);
    const lastMid = layout.middles[layout.middles.length - 1]!;
    expect(lastMid.y + lastMid.h).toBeLessThanOrEqual(height - SANKEY_PAD_BOTTOM + 1e-6);
    const lastSrc = layout.sources[layout.sources.length - 1]!;
    expect(lastSrc.y + lastSrc.h).toBeLessThanOrEqual(height - SANKEY_PAD_BOTTOM + 1e-6);
    for (const node of [...layout.sources, ...layout.middles, ...layout.targets]) {
      expect(Number.isFinite(node.y)).toBe(true);
      expect(Number.isFinite(node.h)).toBe(true);
    }
  });
});

describe("showSankeySourceAmount", () => {
  it("shows name + amount at or above the minimum label height", () => {
    expect(showSankeySourceAmount(SANKEY_SOURCE_AMOUNT_MIN_HEIGHT)).toBe(true);
    expect(showSankeySourceAmount(SANKEY_SOURCE_AMOUNT_MIN_HEIGHT + 100)).toBe(true);
  });

  it("shows name only when the source bar is too short for two lines", () => {
    expect(showSankeySourceAmount(SANKEY_SOURCE_AMOUNT_MIN_HEIGHT - 0.01)).toBe(false);
    expect(showSankeySourceAmount(0)).toBe(false);
  });
});

describe("over-income wording", () => {
  it("names the unfunded slice in the header's own words", () => {
    expect(OVER_INCOME_LABEL).toBe("Over income");
  });
});

describe("sankey transfer flags on layout nodes", () => {
  it("copies the transfer flag from merged rows onto their bars", () => {
    const layout = layoutGroupedIncomeSankey(
      [
        { name: "Payroll", value: 200000, mergedCount: 1 },
        { name: "Withdrawal", value: 50000, mergedCount: 1, transfer: true },
      ],
      [{ name: "Everyday", value: 100000, mergedCount: 1 }],
      [
        { name: "Groceries", value: 70000, mergedCount: 1 },
        { name: "Moved Out", value: 30000, mergedCount: 1, transfer: true },
      ],
      [
        { groupIndex: 0, targetIndex: 0, value: 70000 },
        { groupIndex: 0, targetIndex: 1, value: 30000 },
      ],
      { width: 800, height: 400 }
    );
    expect(layout.sources[0]).not.toHaveProperty("transfer");
    expect(layout.sources[1]).toHaveProperty("transfer", true);
    expect(layout.middles[0]).not.toHaveProperty("transfer");
    expect(layout.targets[0]).not.toHaveProperty("transfer");
    expect(layout.targets[1]).toHaveProperty("transfer", true);
    // The surplus plug is never transfer money.
    const plug = layout.remainingTargetIndex;
    expect(plug).not.toBeNull();
    expect(layout.targets[plug!]).not.toHaveProperty("transfer");
  });
});

describe("sankeyThresholdStops", () => {
  it("starts at 0 and steps small first, larger later (non-linear)", () => {
    expect(SANKEY_THRESHOLD_STOPS[0]).toBe(0);
    const gaps: number[] = [];
    for (let i = 1; i < SANKEY_THRESHOLD_STOPS.length; i++) {
      gaps.push(SANKEY_THRESHOLD_STOPS[i]! - SANKEY_THRESHOLD_STOPS[i - 1]!);
    }
    // Small increments up front, thousand-dollar jumps at the back.
    expect(gaps.slice(0, 4)).toEqual([10, 15, 25, 25]);
    expect(gaps[gaps.length - 1]).toBe(25000);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]!);
    }
  });

  it("covers the largest row with the next canonical stop", () => {
    expect(sankeyThresholdStops(999)).toEqual([
      0, 10, 25, 50, 75, 100, 150, 200, 250, 300, 350, 400, 500, 750, 1000,
    ]);
    expect(sankeyThresholdStops(2000).at(-1)).toBe(2000);
    expect(sankeyThresholdStops(9000).at(-1)).toBe(10000);
  });

  it("floors tiny and degenerate inputs at $50 so the slider stays useful", () => {
    expect(sankeyThresholdStops(0)).toEqual([0, 10, 25, 50]);
    expect(sankeyThresholdStops(-5)).toEqual([0, 10, 25, 50]);
    expect(sankeyThresholdStops(Number.NaN)).toEqual([0, 10, 25, 50]);
  });

  it("doubles past the last canonical stop for huge datasets", () => {
    // Old cap was $2,000; a $60k row now gets a $100k ceiling.
    expect(sankeyThresholdStops(60000).at(-1)).toBe(100000);
    expect(sankeyThresholdStops(150000).slice(-2)).toEqual([100000, 200000]);
    const stops = sankeyThresholdStops(60000);
    expect(stops.slice(0, SANKEY_THRESHOLD_STOPS.length)).toEqual([...SANKEY_THRESHOLD_STOPS]);
  });
});

describe("sankeyThresholdStep", () => {
  const stops = [0, 10, 25, 50, 75, 100, 150, 200, 250, 300, 350, 400, 500];

  it("snaps dollar values to their nearest stop", () => {
    expect(sankeyThresholdStep(stops, 0)).toBe(0);
    expect(sankeyThresholdStep(stops, 320)).toBe(stops.indexOf(300));
    expect(sankeyThresholdStep(stops, 340)).toBe(stops.indexOf(350));
    expect(sankeyThresholdStep(stops, 500)).toBe(stops.indexOf(500));
    expect(sankeyThresholdStep(stops, 99999)).toBe(stops.length - 1);
    expect(sankeyThresholdStep(stops, -20)).toBe(0);
  });

  it("rounds ties down to the smaller stop", () => {
    expect(sankeyThresholdStep(stops, 325)).toBe(stops.indexOf(300));
  });

  it("round-trips through the stops covering real data", () => {
    const data = sankeyThresholdStops(2000);
    for (const dollars of data) {
      expect(data[sankeyThresholdStep(data, dollars)]).toBe(dollars);
    }
  });
});

describe("sankeyAutoFitThreshold", () => {
  const item = (name: string, dollars: number) => ({ name, value: Math.round(dollars * 100) });
  // Eight $10..$80 targets in one group: merging never touches the group
  // (worth $360) or the single income source, so the target column drives.
  const targets = [10, 20, 30, 40, 50, 60, 70, 80].map((d, i) => item(`T${i}`, d));
  const groups = [item("G", 360)];
  const links = targets.map((t, i) => ({ groupIndex: 0, targetIndex: i, value: t.value }));
  const stops = [0, 25, 50, 100];

  it("returns 0 when every row already fits", () => {
    // 8 rows need 8 * 32 + 56 = 312px; income stays under spending (no plug).
    expect(sankeyAutoFitThreshold(groups, targets, links, [item("Pay", 100)], stops, 400)).toBe(0);
    expect(sankeyAutoFitThreshold(groups, targets, links, [item("Pay", 100)], stops, 312)).toBe(0);
  });

  it("returns the smallest stop whose merged columns fit", () => {
    // 6 rows fit in 250px (248px): $25 leaves 7 target rows (280px) but $50
    // merges down to 4 kept + Other = 5 rows (216px).
    expect(sankeyAutoFitThreshold(groups, targets, links, [item("Pay", 100)], stops, 250)).toBe(
      50
    );
  });

  it("counts the Remaining plug row when income exceeds spending", () => {
    // 5 rows fit in exactly 216px, but the plug makes $50 need 6 rows —
    // only the single Other row at $100 (+ plug = 2 rows) fits.
    expect(sankeyAutoFitThreshold(groups, targets, links, [item("Pay", 1000)], stops, 216)).toBe(
      100
    );
  });

  it("merges the income column too when income sources overflow", () => {
    const manyIncome = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((d, i) =>
      item(`Pay${i}`, d)
    );
    const twoTargets = [item("A", 500), item("B", 500)];
    const twoLinks = twoTargets.map((t, i) => ({ groupIndex: 0, targetIndex: i, value: t.value }));
    // 4 rows fit in 200px: $50 leaves 7 income rows but $100 merges to 2.
    expect(sankeyAutoFitThreshold(groups, twoTargets, twoLinks, manyIncome, stops, 200)).toBe(
      100
    );
  });

  it("falls back to the fewest rows when nothing fits", () => {
    // Even one row per column needs 88px; 60px fits nothing, so the top
    // stop (everything in Other) gets as close as merging allows.
    expect(sankeyAutoFitThreshold(groups, targets, links, [item("Pay", 100)], stops, 60)).toBe(
      100
    );
  });

  it("prefers the smallest stop among equally-merged fallbacks", () => {
    // $1000 already merges everything into one row per column; $2000 adds
    // no further merging, so the fallback keeps the smaller stop.
    expect(
      sankeyAutoFitThreshold(groups, targets, links, [item("Pay", 100)], [0, 1000, 2000], 60)
    ).toBe(1000);
  });

  it("returns 0 for empty data or empty stops", () => {
    expect(sankeyAutoFitThreshold([], [], [], [], [0, 10, 25], 400)).toBe(0);
    expect(sankeyAutoFitThreshold(groups, targets, links, [item("Pay", 100)], [], 400)).toBe(0);
  });
});
