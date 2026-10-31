import { describe, expect, it } from "vitest";
import {
  computeDirectFlowLinks,
  computeIncomeBreakdown,
  computeMonthlySankeySeries,
  computeSankeyViewModel,
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
  remainingLanePath,
  sankeyAutoFitThreshold,
  sankeyContentHeight,
  sankeyThresholdStep,
  sankeyThresholdStops,
  sortMergedGroupFlow,
  STARTING_BALANCE_PAYEE,
  STILL_HELD_GROUP_LABEL,
  subdivideBandByValues,
  SANKEY_THRESHOLD_STOPS,
  SANKEY_LABEL_CENTER_MIN,
  SANKEY_MIN_LINK_HEIGHT,
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
  type SpendingGroupFlow,
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

  it("excludes internal on-budget transfers in both dimensions, categorized or not", () => {
    // This used to assert a categorized internal transfer counts as Rent
    // spending — that expectation encoded the bug (task-35): a same-boundary
    // move is movement between pools, not a terminal outflow, so neither leg
    // may appear as spending (or net against it) in either dimension. Only
    // the real June purchase remains.
    const data = makeData();
    data.transactions.push(
      txn("2026-06-15", "Transfer : Savings", -50000, 11, { transferAccountId: 2 })
    );
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([
      { name: "Groceries", value: 5000 },
    ]);
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants")).toEqual([
      { name: "Whole Foods", value: 5000 },
    ]);
  });

  it("nets out a savings round-trip: gross pass-through never shows as spending", () => {
    // Task-35 regression: parking money in an on-budget savings account and
    // withdrawing it again used to show the GROSS inflow as a
    // "Transfer: EQ Bank" merchant ($848,748 in the report) — each leg names
    // the OTHER account, so the legs never shared a payee to net under.
    // Both legs are movement; only the terminal purchase counts.
    const data = makeData();
    data.accounts.push(
      { id: 7, name: "EQ Bank", kind: "liquid", groupLabel: "Budget", balance: "0", onBudget: true, sort: 2 }
    );
    data.transactions.push(
      txn("2026-06-03", "Transfer : EQ Bank", -84874800, null, { transferAccountId: 7 }),
      txn("2026-06-20", "Transfer : Chequing", -84000000, null, { accountId: 7, transferAccountId: 1 }),
      txn("2026-06-21", "Whole Foods", -800000, 10, { accountId: 7 })
    );
    // Categories: the June Groceries rows ($50 at Chequing + $8,000 at EQ
    // Bank); no transfer category is invented.
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([
      { name: "Groceries", value: 805000 },
    ]);
    // Merchants: real payees only — no "Transfer:" node at all.
    const merchants = computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants");
    expect(merchants).toEqual([{ name: "Whole Foods", value: 805000 }]);
    expect(merchants.some((i) => i.name.startsWith("Transfer"))).toBe(false);
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

  it("flows payments to off-budget (tracking) credit accounts through (no terminal allocation)", () => {
    const data = makeData();
    data.accounts.push(
      { id: 4, name: "Tracking Loan", kind: "credit", groupLabel: "Loans", balance: "0", onBudget: false, sort: 3 }
    );
    // This used to assert the payment counts as Groceries spending — that
    // expectation encoded the bug (task-26): a boundary outflow is movement
    // into an intermediate pool, not a terminal outflow allocation. Paying
    // down off-budget debt is saving (net worth rises), so the leg is
    // excluded and only the real June purchase remains.
    data.transactions.push(
      txn("2026-06-15", "Transfer : Tracking Loan", -20000, 10, { transferAccountId: 4 })
    );
    const items = computeSpendingBreakdown(data, "2026-06", "2026-06", "categories");
    expect(items).toEqual([{ name: "Groceries", value: 5000 }]);
  });

  it("excludes both legs of an investment round-trip from spending (flow-through)", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    data.transactions.push(
      txn("2026-06-10", "Transfer : Wealthsimple Trade", -30000, 10, { transferAccountId: 5 }),
      txn("2026-06-20", "Transfer : Wealthsimple Trade", 100000, 10, { transferAccountId: 5 })
    );
    // This used to assert the contribution counts once as a flagged outflow
    // allocation — that expectation encoded the bug (task-26): with
    // flow-through attribution neither leg is terminal, so neither may
    // appear as spending (or net against it) in either dimension.
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([
      { name: "Groceries", value: 5000 },
    ]);
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants")).toEqual([
      { name: "Whole Foods", value: 5000 },
    ]);
  });

  it("excludes moves between two off-budget accounts from spending in both dimensions", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 },
      { id: 6, name: "Wealthsimple TFSA", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 5 }
    );
    data.transactions.push(
      txn("2026-06-10", "Transfer : Wealthsimple TFSA", -30000, 10, { accountId: 5, transferAccountId: 6 })
    );
    // Intermediate-pool movement, not spending — even though categorized.
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([
      { name: "Groceries", value: 5000 },
    ]);
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants")).toEqual([
      { name: "Whole Foods", value: 5000 },
    ]);
  });

  it("excludes a contribution recorded on the off-budget leg from spending", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    // Same contribution as usual, recorded inside the investment account as
    // a positive transfer row — still movement, still excluded.
    data.transactions.push(
      txn("2026-06-10", "Transfer : Chequing", 30000, 10, { accountId: 5, transferAccountId: 1 })
    );
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([
      { name: "Groceries", value: 5000 },
    ]);
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants")).toEqual([
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

  it("merges both columns into plain Other buckets with no vestigial flags", () => {
    const merged = mergeGroupFlow(
      [
        { name: "Big", value: 9000 },
        { name: "Small", value: 1000 },
      ],
      [
        { name: "Kept", value: 9000 },
        { name: "Moved Out", value: 1000 },
      ],
      [
        { groupIndex: 0, targetIndex: 0, value: 9000 },
        { groupIndex: 1, targetIndex: 1, value: 1000 },
      ],
      5000
    );
    expect(merged.targets).toEqual([
      { name: "Kept", value: 9000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 1000, mergedCount: 1, bucket: true },
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

  it("keeps kept rows and the Other bucket free of vestigial flags", () => {
    const merged = mergeBelowThreshold(
      [
        { name: "Big", value: 10000 },
        { name: "Mid", value: 4000 },
        { name: "Small", value: 1000 },
      ],
      5000
    );
    expect(merged.items).toEqual([
      { name: "Big", value: 10000, mergedCount: 1 },
      { name: OTHER_BUCKET_LABEL, value: 5000, mergedCount: 2, bucket: true },
    ]);
    for (const item of merged.items) {
      expect(item).not.toHaveProperty("transfer");
    }
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

  it("excludes investment withdrawals from income, categorized or not (pass-through principal)", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    data.transactions.push(
      txn("2026-06-10", "Transfer : Wealthsimple Trade", 100000, 10, { transferAccountId: 5 }),
      txn("2026-06-11", "Transfer : Wealthsimple Trade", 50000, null, { transferAccountId: 5 })
    );
    // This used to assert withdrawals count as flagged income at face value —
    // that expectation encoded the bug (task-26): a withdrawal returns
    // pass-through principal, not new money, so money coming back must not
    // appear as unattributed income. (The uncategorized leg is income to the
    // budget engine — the report must exclude it anyway; see below.)
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([]);
  });

  it("excludes withdrawals recorded on the off-budget leg from income", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    // This used to assert the off-budget leg counts at its budget value
    // (+75000) — that expectation encoded the bug (task-26): whichever leg
    // the withdrawal was recorded on, it is pass-through principal.
    data.transactions.push(
      txn("2026-06-12", "Transfer : Chequing", -75000, null, { accountId: 5, transferAccountId: 1 })
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([]);
  });

  it("keeps only plain income when it mixes with withdrawals (no flags)", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    data.transactions.push(
      txn("2026-06-10", "Transfer : Wealthsimple Trade", 100000, 10, { transferAccountId: 5 }),
      txn("2026-06-11", "Bonus", 20000, null)
    );
    // This used to assert the withdrawal source is kept and flagged — that
    // expectation encoded the bug (task-26): the withdrawal is excluded and
    // nothing is flagged anymore.
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "Bonus", value: 20000 },
    ]);
  });

  it("counts off-budget account profit as income under the account's own name", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    // External growth recorded directly in the account: dividends and
    // interest with arbitrary payees — all profit, all grouped under the
    // account name (the account is the income source), never flagged.
    data.transactions.push(
      txn("2026-06-10", "Dividend", 15000, null, { accountId: 5 }),
      txn("2026-06-11", "Interest", 5000, null, { accountId: 5 })
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "Wealthsimple Trade", value: 20000 },
    ]);
  });

  it("respects the month range and split discipline for profit rows", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    data.transactions.push(
      txn("2026-05-10", "Dividend", 15000, null, { accountId: 5 }),
      txn("2026-06-10", "Split Profit", 40000, null, { accountId: 5, id: 900 }),
      txn("2026-06-10", "Split Profit", 30000, null, { accountId: 5, id: 901, parentId: 900 }),
      txn("2026-06-10", "Split Profit", 10000, 10, { accountId: 5, id: 902, parentId: 900 })
    );
    // May dividend only in the wide range (next to May's Payroll); the
    // split parent never counts and the categorized child is a refund.
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "Wealthsimple Trade", value: 30000 },
    ]);
    expect(computeIncomeBreakdown(data, "2026-05", "2026-06")).toEqual([
      { name: "Payroll", value: 300000 },
      { name: "Wealthsimple Trade", value: 45000 },
    ]);
  });

  it("treats categorized positives on off-budget accounts as refunds, not profit", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    data.transactions.push(
      txn("2026-06-10", "Airline", -80000, 10, { accountId: 5 }),
      txn("2026-06-11", "Airline Refund", 10000, 10, { accountId: 5 })
    );
    // The refund must not ALSO count as income (that would double-count:
    // +income and -spending from one $100 row).
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([]);
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([
      { name: "Groceries", value: 75000 },
    ]);
  });

  it("treats uncategorized negatives on off-budget accounts as spending, not income corrections", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    data.transactions.push(
      txn("2026-06-10", "Dividend", 20000, null, { accountId: 5 }),
      txn("2026-06-11", "Account Fee", -5000, null, { accountId: 5 })
    );
    // Gross presentation (matches on-budget rows): the dividend is profit
    // income, the fee is merchant spending — the fee never nets the income.
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "Wealthsimple Trade", value: 20000 },
    ]);
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants")).toEqual([
      { name: "Whole Foods", value: 5000 },
      { name: "Account Fee", value: 5000 },
    ]);
  });

  it("never counts transfer rows as profit, even positive uncategorized ones on off-budget legs", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    // A contribution recorded on the off-budget leg: positive and
    // uncategorized, but still a transfer — pass-through, not profit.
    data.transactions.push(
      txn("2026-06-10", "Transfer : Chequing", 30000, null, { accountId: 5, transferAccountId: 1 })
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([]);
  });

  it("counts isIncome:false off-budget rows as profit (import-realistic: the flag is ignored off-budget)", () => {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 }
    );
    // This used to assert an explicit isIncome:false excludes the row — that
    // expectation encoded the bug (task-49): the YNAB4 import sets
    // isIncome=false for EVERY off-budget regular row, and the budget engine
    // ignores the flag off-budget (isIncomeTransaction returns false before
    // ever reading it), so the guard excluded ALL genuine imported profit.
    // Genuine profit counts regardless of the flag now.
    data.transactions.push(
      txn("2026-06-10", "Mystery Credit", 20000, null, { accountId: 5, isIncome: false })
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "Wealthsimple Trade", value: 20000 },
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

describe("sankey flow-through attribution", () => {
  // Salary → investment account → vacation must read as salary → vacation:
  // intermediate off-budget pools collapse, the final purchase is the one
  // spending record, and each account contributes only its own profit.
  function flowData(): BudgetData {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 },
      { id: 6, name: "Wealthsimple TFSA", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 5 }
    );
    data.groups.push({ id: 2, name: "Bills", sort: 1, isCreditCardPayments: false });
    data.categories.push(
      { id: 12, groupId: 1, name: "Vacation", sort: 2, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 13, groupId: 2, name: "Dining", sort: 3, carryover: "0", goalTarget: null, linkedAccountId: null }
    );
    // Isolate the scenario: drop the shared fixture's own rows.
    data.transactions = [];
    return data;
  }

  function asMerged(items: { name: string; value: number }[]): MergedSpendingItem[] {
    return items.map((i) => ({ ...i, mergedCount: 1 }));
  }

  it("traces salary through a withdrawal back into the budget (salary → vacation)", () => {
    const data = flowData();
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-05", "Transfer : Wealthsimple Trade", -100000, 12, { transferAccountId: 5 }),
      // Uncategorized withdrawal: income to the budget engine, but
      // pass-through principal to the report — it must still be excluded.
      txn("2026-06-10", "Transfer : Wealthsimple Trade", 100000, null, { transferAccountId: 5 }),
      txn("2026-06-12", "Airline", -100000, 12)
    );
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    expect(income).toEqual([{ name: "Payroll", value: 100000 }]);
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(flow.targets).toEqual([{ name: "Vacation", value: 100000 }]);
    expect(flow.groups).toEqual([{ name: "Everyday", value: 100000 }]);
    expect(flow.links).toEqual([{ groupIndex: 0, targetIndex: 0, value: 100000 }]);
    // No dollar appears as both an outflow allocation and traced income:
    // neither column names a transfer leg.
    expect(income.some((i) => i.name.startsWith("Transfer"))).toBe(false);
    expect(flow.targets.some((t) => t.name.startsWith("Transfer"))).toBe(false);
    // The left hop attributes the whole vacation to the original source.
    const model = computeDirectFlowLinks(asMerged(income), asMerged(flow.groups));
    expect(model.links).toEqual([{ sourceIndex: 0, targetIndex: 0, value: 100000 }]);
  });

  it("traces salary through direct spending from the investment account", () => {
    const data = flowData();
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-05", "Transfer : Wealthsimple Trade", -100000, 12, { transferAccountId: 5 }),
      txn("2026-06-12", "Airline", -100000, 12, { accountId: 5 })
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "Payroll", value: 100000 },
    ]);
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([
      { name: "Vacation", value: 100000 },
    ]);
    // Merchant mode names the merchant, never the contribution leg.
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants")).toEqual([
      { name: "Airline", value: 100000 },
    ]);
  });

  it("counts account growth as profit-only income (partial profit)", () => {
    const data = flowData();
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-05", "Transfer : Wealthsimple Trade", -100000, 12, { transferAccountId: 5 }),
      txn("2026-06-08", "Dividend", 20000, null, { accountId: 5 }),
      txn("2026-06-10", "Transfer : Wealthsimple Trade", 80000, null, { transferAccountId: 5 }),
      txn("2026-06-12", "Airline", -80000, 12)
    );
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    // The account is an income source for its $200 profit only — never the
    // $1,000 pass-through principal.
    expect(income).toEqual([
      { name: "Payroll", value: 100000 },
      { name: "Wealthsimple Trade", value: 20000 },
    ]);
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(flow.targets).toEqual([{ name: "Vacation", value: 80000 }]);
    // $1,200 in, $800 out: the $400 surplus (unspent principal + unspent
    // profit) lands in Remaining, and every source's outgoing still equals
    // its own value (no dollar created or lost).
    const model = computeDirectFlowLinks(asMerged(income), asMerged(flow.groups));
    expect(model.incomeTotal).toBe(120000);
    expect(model.spendingTotal).toBe(80000);
    expect(model.targets[1]).toEqual({ name: REMAINING_LABEL, value: 40000, mergedCount: 1 });
    for (let i = 0; i < income.length; i++) {
      const out = model.links
        .filter((l) => l.sourceIndex === i)
        .reduce((s, l) => s + l.value, 0);
      expect(out).toBeCloseTo(income[i]!.value, 9);
    }
    // The vacation draws pro-rata: 5/6 salary, 1/6 account profit.
    const intoVacation = model.links.filter((l) => l.targetIndex === 0);
    expect(intoVacation).toHaveLength(2);
    expect(intoVacation[0]!.value).toBeCloseTo((80000 * 100000) / 120000, 9);
    expect(intoVacation[1]!.value).toBeCloseTo((80000 * 20000) / 120000, 9);
  });

  it("breaks even with no profit source when outflows equal inflows", () => {
    const data = flowData();
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-05", "Transfer : Wealthsimple Trade", -100000, 12, { transferAccountId: 5 }),
      txn("2026-06-12", "Airline", -100000, 12, { accountId: 5 })
    );
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    expect(income).toEqual([{ name: "Payroll", value: 100000 }]);
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    // Fully spent with no growth: income equals outflows, no Remaining plug.
    const model = computeDirectFlowLinks(asMerged(income), asMerged(flow.groups));
    expect(model.incomeTotal).toBe(model.spendingTotal);
    expect(model.targets).toHaveLength(1);
  });

  it("clamps a loss at zero and funds the shortfall pro-rata (no negative income)", () => {
    const data = flowData();
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-05", "Transfer : Wealthsimple Trade", -100000, 12, { transferAccountId: 5 }),
      // $1,500 out of $1,000 in: the extra $500 came from pre-period
      // balances (there is no mark-to-market in transaction data).
      txn("2026-06-12", "Airline", -150000, 12, { accountId: 5 })
    );
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    expect(income).toEqual([{ name: "Payroll", value: 100000 }]);
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(flow.targets).toEqual([{ name: "Vacation", value: 150000 }]);
    // No negative income node is invented: the uniform coverage ratio funds
    // every expense at 2/3 and the $500 shortfall stays unfunded, reducing
    // the attributed source proportionally.
    const model = computeDirectFlowLinks(asMerged(income), asMerged(flow.groups));
    expect(model.funded).toEqual([100000]);
    expect(model.unfunded).toEqual([50000]);
    expect(model.links).toEqual([{ sourceIndex: 0, targetIndex: 0, value: 100000 }]);
  });

  it("traces through multi-hop chains (A→B→C→spending)", () => {
    const data = flowData();
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-05", "Transfer : Wealthsimple Trade", -100000, 12, { transferAccountId: 5 }),
      txn("2026-06-06", "Transfer : Wealthsimple TFSA", -100000, 12, { accountId: 5, transferAccountId: 6 }),
      txn("2026-06-10", "Transfer : Wealthsimple TFSA", 100000, null, { transferAccountId: 6 }),
      txn("2026-06-12", "Airline", -100000, 12)
    );
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "Payroll", value: 100000 },
    ]);
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([
      { name: "Vacation", value: 100000 },
    ]);
    // Every intermediate leg collapses — including the off→off hop, which
    // merchant mode would otherwise name as a Transfer merchant.
    const merchants = computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants");
    expect(merchants).toEqual([{ name: "Airline", value: 100000 }]);
  });

  it("attributes mixed sources through one account to two spends", () => {
    const data = flowData();
    data.transactions.push(
      txn("2026-06-01", "Payroll", 80000, null),
      txn("2026-06-02", "Bonus", 20000, null),
      txn("2026-06-05", "Transfer : Wealthsimple Trade", -80000, 12, { transferAccountId: 5 }),
      txn("2026-06-06", "Transfer : Wealthsimple Trade", -20000, 12, { transferAccountId: 5 }),
      txn("2026-06-12", "Airline", -60000, 12, { accountId: 5 }),
      txn("2026-06-13", "Bistro", -40000, 13, { accountId: 5 })
    );
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    expect(income).toEqual([
      { name: "Payroll", value: 80000 },
      { name: "Bonus", value: 20000 },
    ]);
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(flow.targets).toEqual([
      { name: "Vacation", value: 60000 },
      { name: "Dining", value: 40000 },
    ]);
    expect(flow.groups).toEqual([
      { name: "Everyday", value: 60000 },
      { name: "Bills", value: 40000 },
    ]);
    // Fungible pro-rata through the pool: each group draws 80/20, so each
    // source's traced total still equals its own income (no double-count).
    const model = computeDirectFlowLinks(asMerged(income), asMerged(flow.groups));
    expect(model.links).toEqual([
      { sourceIndex: 0, targetIndex: 0, value: 48000 },
      { sourceIndex: 1, targetIndex: 0, value: 12000 },
      { sourceIndex: 0, targetIndex: 1, value: 32000 },
      { sourceIndex: 1, targetIndex: 1, value: 8000 },
    ]);
  });

  it("conserves every dollar: traced income + profit == outflows (+ Remaining)", () => {
    const data = flowData();
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-05", "Transfer : Wealthsimple Trade", -100000, 12, { transferAccountId: 5 }),
      txn("2026-06-08", "Dividend", 20000, null, { accountId: 5 }),
      txn("2026-06-12", "Airline", -60000, 12, { accountId: 5 }),
      txn("2026-06-13", "Bistro", -40000, 13)
    );
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    const incomeTotal = income.reduce((s, i) => s + i.value, 0);
    const spendingTotal = flow.targets.reduce((s, t) => s + t.value, 0);
    expect(incomeTotal).toBe(120000);
    expect(spendingTotal).toBe(100000);
    // The $200 gap is exactly the unspent remainder — nothing vanished
    // into (or appeared from) the intermediate legs.
    const model = computeDirectFlowLinks(asMerged(income), asMerged(flow.groups));
    expect(model.incomeTotal).toBe(model.spendingTotal + (model.targets[2]?.value ?? 0));
    expect(model.targets[2]).toEqual({ name: REMAINING_LABEL, value: 20000, mergedCount: 1 });
    // Group-flow marginals still hold with off-budget spending in the mix.
    for (let i = 0; i < flow.groups.length; i++) {
      const out = flow.links.filter((l) => l.groupIndex === i).reduce((s, l) => s + l.value, 0);
      expect(out).toBeCloseTo(flow.groups[i]!.value, 9);
    }
    for (let j = 0; j < flow.targets.length; j++) {
      const into = flow.links.filter((l) => l.targetIndex === j).reduce((s, l) => s + l.value, 0);
      expect(into).toBeCloseTo(flow.targets[j]!.value, 9);
    }
  });

  it("flows the downpayment chain end to end (SAP Concur → Questrade → Wealthsimple Trade → Downpayment)", () => {
    const data = flowData();
    data.accounts.push(
      { id: 7, name: "Questrade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 6 }
    );
    // The last pool still holds the unspent $50,000 at range end.
    data.accounts.find((a) => a.id === 5)!.balance = "50000";
    data.categories.push(
      { id: 14, groupId: 1, name: "Downpayment", sort: 4, carryover: "0", goalTarget: null, linkedAccountId: null }
    );
    data.transactions.push(
      txn("2026-06-01", "SAP Concur", 200000, null),
      txn("2026-06-02", "Transfer : Questrade", -200000, 14, { transferAccountId: 7 }),
      txn("2026-06-03", "Transfer : Wealthsimple Trade", -200000, 14, { accountId: 7, transferAccountId: 5 }),
      txn("2026-06-04", "Transfer : Wealthsimple Trade", 150000, null, { transferAccountId: 5 }),
      txn("2026-06-05", "Title Company", -150000, 14)
    );
    // The original external source funds the final purchase: every
    // intermediate leg collapses, however deep the chain.
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([
      { name: "SAP Concur", value: 200000 },
    ]);
    // The $50,000 that never left the chain is a first-class chart row in
    // both dimensions — the last pool under the Still-held pseudo-group —
    // next to the final purchase (task-49 replaces the task-48 strip query
    // with these row assertions).
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", dimension);
      expect(flow.targets).toContainEqual({ name: "Wealthsimple Trade", value: 50000 });
      expect(flow.groups).toContainEqual({ name: STILL_HELD_GROUP_LABEL, value: 50000 });
      const gi = flow.groups.findIndex((g) => g.name === STILL_HELD_GROUP_LABEL);
      const ti = flow.targets.findIndex((t) => t.name === "Wealthsimple Trade");
      expect(flow.links).toContainEqual({ groupIndex: gi, targetIndex: ti, value: 50000 });
    }
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toContainEqual(
      { name: "Downpayment", value: 150000 }
    );
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants")).toContainEqual(
      { name: "Title Company", value: 150000 }
    );
  });

  it("attributes appreciation to the growing account only (Questrade → Downpayment for the profit)", () => {
    const data = flowData();
    data.accounts.push(
      { id: 7, name: "Questrade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 6 }
    );
    data.categories.push(
      { id: 14, groupId: 1, name: "Downpayment", sort: 4, carryover: "0", goalTarget: null, linkedAccountId: null }
    );
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-02", "Transfer : Questrade", -100000, 14, { transferAccountId: 7 }),
      txn("2026-06-03", "Dividend", 20000, null, { accountId: 7 }),
      txn("2026-06-04", "Transfer : Wealthsimple Trade", -120000, 14, { accountId: 7, transferAccountId: 5 }),
      txn("2026-06-05", "Transfer : Wealthsimple Trade", 120000, null, { transferAccountId: 5 }),
      txn("2026-06-06", "Title Company", -120000, 14)
    );
    // Questrade is a source for its $200 profit only; Wealthsimple Trade is
    // pure pass-through principal, so it appears in NEITHER column.
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    expect(income).toEqual([
      { name: "Payroll", value: 100000 },
      { name: "Questrade", value: 20000 },
    ]);
    expect(income.some((i) => i.name === "Wealthsimple Trade")).toBe(false);
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([
      { name: "Downpayment", value: 120000 },
    ]);
    // Both pools fully cycled: no Still-held group anywhere, in either
    // dimension (task-49 replaces the task-48 strip query with this).
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", dimension);
      expect(flow.groups.some((g) => g.name === STILL_HELD_GROUP_LABEL)).toBe(false);
      expect(flow.targets.some((t) => t.name === "Wealthsimple Trade")).toBe(false);
      expect(flow.targets.some((t) => t.name === "Questrade")).toBe(false);
    }
  });
});

describe("still-held accounts as chart rows", () => {
  // Still-held off-budget accounts draw as first-class right-column rows
  // (named by the account, routed through the Still-held pseudo-group) in
  // both dimensions — replacing the task-48 strip.
  function heldData(): BudgetData {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 },
      { id: 6, name: "RRSP", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 5 },
      { id: 7, name: "TFSA", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 6 }
    );
    data.transactions = [];
    return data;
  }

  const setBalance = (data: BudgetData, id: number, balance: string) => {
    data.accounts.find((a) => a.id === id)!.balance = balance;
  };

  // Held rows of a flow: targets fed ONLY through the Still-held group.
  const heldTargetsOf = (flow: SpendingGroupFlow): { name: string; value: number }[] =>
    flow.targets.filter((_, ti) => {
      const incoming = flow.links.filter((l) => l.targetIndex === ti);
      return (
        incoming.length > 0 &&
        incoming.every((l) => flow.groups[l.groupIndex]?.name === STILL_HELD_GROUP_LABEL)
      );
    });

  const fundedInto = (
    vm: ReturnType<typeof computeSankeyViewModel>,
    source: string,
    target: string
  ): number => {
    const si = vm.sources.findIndex((s) => s.name === source);
    const cis = new Set(
      vm.links
        .map((l, k) => ({ l, k }))
        .filter(({ l }) => vm.targets[l.targetIndex]?.name === target)
        .map(({ k }) => k)
    );
    return vm.left.cells
      .filter((c) => c.sourceIndex === si && cis.has(c.rightLinkIndex))
      .reduce((s, c) => s + c.value, 0);
  };

  it("shows the original source → purchase ribbon plus a Still-held row for the remainder (all-time style)", () => {
    const data = heldData();
    setBalance(data, 6, "40000");
    data.categories.push(
      { id: 14, groupId: 1, name: "Downpayment", sort: 4, carryover: "0", goalTarget: null, linkedAccountId: null }
    );
    data.transactions.push(
      txn("2026-04-01", "Payroll", 100000, null),
      txn("2026-04-02", "Transfer : RRSP", -100000, 14, { transferAccountId: 6 }),
      txn("2026-05-03", "Dividend", 20000, null, { accountId: 6, isIncome: false }),
      txn("2026-06-04", "Transfer : RRSP", 80000, null, { transferAccountId: 6 }),
      txn("2026-06-05", "Title Company", -80000, 14)
    );
    // The import-realistic isIncome:false profit counts under the account.
    const income = computeIncomeBreakdown(data, "2026-04", "2026-06");
    expect(income).toEqual([
      { name: "Payroll", value: 100000 },
      { name: "RRSP", value: 20000 },
    ]);
    // Both dimensions draw the purchase AND the $400 remainder under the
    // Still-held pseudo-group.
    const catFlow = computeSpendingGroupFlow(data, "2026-04", "2026-06", "categories");
    expect(catFlow.targets).toEqual([
      { name: "Downpayment", value: 80000 },
      { name: "RRSP", value: 40000 },
    ]);
    expect(catFlow.groups).toEqual([
      { name: "Everyday", value: 80000 },
      { name: STILL_HELD_GROUP_LABEL, value: 40000 },
    ]);
    expect(catFlow.links).toEqual([
      { groupIndex: 0, targetIndex: 0, value: 80000 },
      { groupIndex: 1, targetIndex: 1, value: 40000 },
    ]);
    const merchFlow = computeSpendingGroupFlow(data, "2026-04", "2026-06", "merchants");
    expect(merchFlow.targets).toEqual([
      { name: "Title Company", value: 80000 },
      { name: "RRSP", value: 40000 },
    ]);
    expect(heldTargetsOf(merchFlow)).toEqual([{ name: "RRSP", value: 40000 }]);
    // Funding: the original source reaches the purchase (Payroll →
    // Downpayment) and the profit funds downstream too; both cells are
    // fully funded, so no Remaining plug survives.
    const series = computeMonthlySankeySeries(data, "2026-04", "2026-06", "categories");
    const vm = computeSankeyViewModel(catFlow, income, series, { thresholdCents: 0 });
    expect(vm.left.incomeTotal).toBe(120000);
    expect(vm.left.spendingTotal).toBeCloseTo(120000, 9);
    expect(fundedInto(vm, "Payroll", "Downpayment")).toBeGreaterThan(0);
    expect(fundedInto(vm, "RRSP", "Downpayment")).toBeGreaterThan(0);
    expect(fundedInto(vm, "Payroll", "Downpayment") + fundedInto(vm, "RRSP", "Downpayment")).toBeCloseTo(80000, 9);
    expect(fundedInto(vm, "Payroll", "RRSP") + fundedInto(vm, "RRSP", "RRSP")).toBeCloseTo(40000, 9);
    expect(vm.left.remainingBySource).toEqual([0, 0]);
  });

  it("funds downstream cells from isIncome:false profit (Questrade → Downpayment)", () => {
    const data = heldData();
    data.accounts.push(
      { id: 8, name: "Questrade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 7 }
    );
    data.categories.push(
      { id: 14, groupId: 1, name: "Downpayment", sort: 4, carryover: "0", goalTarget: null, linkedAccountId: null }
    );
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-02", "Transfer : Questrade", -100000, 14, { transferAccountId: 8 }),
      txn("2026-06-03", "Dividend", 20000, null, { accountId: 8, isIncome: false }),
      txn("2026-06-04", "Transfer : Questrade", 120000, null, { transferAccountId: 8 }),
      txn("2026-06-05", "Title Company", -120000, 14)
    );
    // Questrade fully cycled (net zero): an income source only, no held row.
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    expect(income).toEqual([
      { name: "Payroll", value: 100000 },
      { name: "Questrade", value: 20000 },
    ]);
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(flow.targets).toEqual([{ name: "Downpayment", value: 120000 }]);
    expect(flow.groups.some((g) => g.name === STILL_HELD_GROUP_LABEL)).toBe(false);
    // The profit FUNDS the purchase: Questrade → Downpayment. Single month,
    // so the exact fungible share — 1/6 of the purchase.
    const series = computeMonthlySankeySeries(data, "2026-06", "2026-06", "categories");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    expect(fundedInto(vm, "Questrade", "Downpayment")).toBeCloseTo(20000, 9);
  });

  it("excludes Starting Balance appraisal rows from income, spending, and held", () => {
    const data = heldData();
    data.accounts.push(
      { id: 8, name: "Home Value", kind: "offbudget", groupLabel: "Property", balance: "97900000", onBudget: false, sort: 7 },
      { id: 9, name: "Mortgage Debt", kind: "offbudget", groupLabel: "Property", balance: "-97900000", onBudget: false, sort: 8 }
    );
    data.transactions.push(
      txn("2026-04-21", STARTING_BALANCE_PAYEE, 97900000, null, { accountId: 8 }),
      txn("2026-04-21", STARTING_BALANCE_PAYEE, -97900000, null, { accountId: 9 })
    );
    // The ±$979k appraisal pair is stock recognition: it appears NOWHERE.
    expect(computeIncomeBreakdown(data, "2026-04", "2026-06")).toEqual([]);
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, "2026-04", "2026-06", dimension);
      expect(flow.targets).toEqual([]);
      expect(flow.groups).toEqual([]);
      expect(flow.links).toEqual([]);
    }
  });

  it("excludes on-budget and credit opening rows from income and merchant spending", () => {
    const data = makeData();
    data.accounts.push(
      { id: 3, name: "Visa", kind: "credit", groupLabel: "Credit", balance: "-389784", onBudget: true, sort: 2 }
    );
    data.transactions = [
      txn("2026-04-01", STARTING_BALANCE_PAYEE, 670000, null, { isIncome: true }),
      txn("2026-04-01", STARTING_BALANCE_PAYEE, -389784, null, { accountId: 3 }),
    ];
    // The $6,700 on-budget opening balance is not income (even flagged
    // isIncome:true); the credit opening balance is not merchant spending.
    expect(computeIncomeBreakdown(data, "2026-04", "2026-06")).toEqual([]);
    expect(computeSpendingBreakdown(data, "2026-04", "2026-06", "merchants")).toEqual([]);
    expect(computeSpendingBreakdown(data, "2026-04", "2026-06", "categories")).toEqual([]);
  });

  it("excludes Starting Balance rows from held nets (but keeps them in the range-end stock)", () => {
    const data = heldData();
    // RRSP opened in-range ($1,000 stock recognition) plus a $400 real
    // contribution; the held row values the FLOW only.
    setBalance(data, 6, "140000");
    data.transactions.push(
      txn("2026-06-01", STARTING_BALANCE_PAYEE, 100000, null, { accountId: 6 }),
      txn("2026-06-02", "Transfer : RRSP", -40000, 10, { transferAccountId: 6 })
    );
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(heldTargetsOf(flow)).toEqual([{ name: "RRSP", value: 40000 }]);
    expect(flow.groups).toContainEqual({ name: STILL_HELD_GROUP_LABEL, value: 40000 });
  });

  it("does not hold debt paydown: a positive range net with a negative range-end balance is excluded", () => {
    const data = heldData();
    data.accounts.push(
      { id: 8, name: "Mortgage Debt", kind: "offbudget", groupLabel: "Property", balance: "-66025355", onBudget: false, sort: 7 }
    );
    data.categories.push(
      { id: 14, groupId: 1, name: "Mortgage Principal", sort: 4, carryover: "0", goalTarget: null, linkedAccountId: null }
    );
    data.transactions.push(
      // Categorized principal payments INTO the mortgage account: transfers,
      // so never spending — but a +$325k range net for the account.
      txn("2026-06-05", "Transfer : Mortgage Debt", -32500000, 14, { transferAccountId: 8 })
    );
    // Liability reduction is not holdings: no row in either dimension.
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", dimension);
      expect(flow.groups.some((g) => g.name === STILL_HELD_GROUP_LABEL)).toBe(false);
      expect(flow.targets.some((t) => t.name === "Mortgage Debt")).toBe(false);
    }
    // Sanity: the payment is not spending either (off-budget transfer leg).
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([]);
  });

  it("excludes accounts holding nothing at range end (in-range refill of a pre-range drawdown)", () => {
    const data = heldData();
    setBalance(data, 6, "0");
    data.transactions.push(
      txn("2026-05-02", "Transfer : RRSP", 50000, null, { transferAccountId: 6 }),
      txn("2026-06-03", "Transfer : RRSP", -50000, 10, { transferAccountId: 6 })
    );
    // June nets +$500 but the account holds $0 at range end (the $500
    // refilled May's hole): no row.
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(flow.groups.some((g) => g.name === STILL_HELD_GROUP_LABEL)).toBe(false);
  });

  it("still holds money withdrawn after the range (range-end, not current, governs)", () => {
    const data = heldData();
    setBalance(data, 6, "0");
    data.transactions.push(
      txn("2026-06-02", "Transfer : RRSP", -50000, 10, { transferAccountId: 6 }),
      txn("2026-07-04", "Transfer : RRSP", 50000, null, { transferAccountId: 6 })
    );
    // At the June range end the RRSP held $500 — the July withdrawal adds
    // back into the range-end stock, so the held row stands.
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(heldTargetsOf(flow)).toEqual([{ name: "RRSP", value: 50000 }]);
  });

  it("reconciles income = spending + held + remaining in both dimensions", () => {
    const data = heldData();
    setBalance(data, 6, "40000");
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-02", "Transfer : RRSP", -70000, 10, { transferAccountId: 6 }),
      txn("2026-06-03", "Dividend", 10000, null, { accountId: 6, isIncome: false }),
      txn("2026-06-04", "Transfer : RRSP", 40000, null, { transferAccountId: 6 }),
      txn("2026-06-05", "Grocer", -30000, 10)
    );
    // Income $1,100 (Payroll + RRSP profit); RRSP nets +$400 held ($700 +
    // $100 − $400); Groceries $300 spent; $400 unspent.
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    expect(income).toEqual([
      { name: "Payroll", value: 100000 },
      { name: "RRSP", value: 10000 },
    ]);
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", dimension);
      const series = computeMonthlySankeySeries(data, "2026-06", "2026-06", dimension);
      const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
      const held = heldTargetsOf(flow).reduce((s, t) => s + t.value, 0);
      const spending = flow.targets.reduce((s, t) => s + t.value, 0) - held;
      const remaining = vm.left.remainingBySource.reduce((s, v) => s + v, 0);
      expect(vm.left.incomeTotal).toBe(110000);
      expect(spending).toBe(30000);
      expect(held).toBe(40000);
      expect(remaining).toBeCloseTo(40000, 9);
      expect(spending + held + remaining).toBeCloseTo(vm.left.incomeTotal, 9);
    }
  });

  it("keeps held months via scaled positive parts (withdrawals wash out)", () => {
    const data = heldData();
    setBalance(data, 6, "50000");
    data.transactions.push(
      txn("2026-04-02", "Transfer : RRSP", -60000, 10, { transferAccountId: 6 }),
      txn("2026-05-03", "Transfer : RRSP", 20000, null, { transferAccountId: 6 }),
      txn("2026-06-04", "Transfer : RRSP", -10000, 10, { transferAccountId: 6 })
    );
    // Nets [+60000, −20000, +10000] net +50000; positives total 70000.
    const series = computeMonthlySankeySeries(data, "2026-04", "2026-06", "categories");
    expect(series.months).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(series.targetNames).toEqual(["RRSP"]);
    expect(series.groupNames).toEqual([STILL_HELD_GROUP_LABEL]);
    const col = series.cellByMonth.map((row) => row[0]);
    expect(col[0]).toBeCloseTo((60000 * 50000) / 70000, 9);
    expect(col[1]).toBe(0);
    expect(col[2]).toBeCloseTo((10000 * 50000) / 70000, 9);
    expect(col[0]! + col[1]! + col[2]!).toBeCloseTo(50000, 9);
  });

  it("funds held demands chronologically against spending (early income never funds late spending)", () => {
    const data = heldData();
    setBalance(data, 6, "100000");
    data.transactions.push(
      txn("2026-04-01", "Payroll", 100000, null),
      txn("2026-04-02", "Transfer : RRSP", -100000, 10, { transferAccountId: 6 }),
      txn("2026-05-01", "Bonus", 50000, null),
      txn("2026-05-05", "Grocer", -50000, 10)
    );
    const income = computeIncomeBreakdown(data, "2026-04", "2026-05");
    const flow = computeSpendingGroupFlow(data, "2026-04", "2026-05", "categories");
    const series = computeMonthlySankeySeries(data, "2026-04", "2026-05", "categories");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    // April Payroll is fully absorbed by the April held demand; May Bonus
    // alone funds the May groceries — the held cell competes
    // chronologically in the same allocator.
    expect(fundedInto(vm, "Payroll", "RRSP")).toBeCloseTo(100000, 9);
    expect(fundedInto(vm, "Bonus", "RRSP")).toBeCloseTo(0, 9);
    expect(fundedInto(vm, "Bonus", "Groceries")).toBeCloseTo(50000, 9);
    expect(fundedInto(vm, "Payroll", "Groceries")).toBeCloseTo(0, 9);
    expect(vm.left.remainingBySource).toEqual([0, 0]);
  });

  it("counts external profit as held and shifts held money on off→off moves", () => {
    const data = heldData();
    setBalance(data, 7, "80000");
    data.transactions.push(
      txn("2026-06-02", "Transfer : RRSP", -60000, 10, { transferAccountId: 6 }),
      txn("2026-06-03", "Dividend", 20000, null, { accountId: 6, isIncome: false }),
      txn("2026-06-04", "Transfer : TFSA", -80000, 10, { accountId: 6, transferAccountId: 7 })
    );
    // The $600 contribution plus $200 profit moved pools intact: RRSP nets
    // to zero (omitted) and TFSA holds the full $800.
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(heldTargetsOf(flow)).toEqual([{ name: "TFSA", value: 80000 }]);
    expect(flow.groups).toContainEqual({ name: STILL_HELD_GROUP_LABEL, value: 80000 });
  });

  it("omits fully-cycled and drawn-down accounts (clamped at zero)", () => {
    const data = heldData();
    setBalance(data, 6, "0");
    setBalance(data, 7, "-20000");
    data.transactions.push(
      txn("2026-06-02", "Transfer : RRSP", -50000, 10, { transferAccountId: 6 }),
      txn("2026-06-03", "Transfer : RRSP", 50000, null, { transferAccountId: 6 }),
      txn("2026-06-04", "Transfer : TFSA", -50000, 10, { transferAccountId: 7 }),
      txn("2026-06-05", "Transfer : TFSA", 70000, null, { transferAccountId: 7 })
    );
    // RRSP fully cycled (net zero); TFSA drew down $200 of pre-period
    // savings (net −$200) — neither draws a row.
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(heldTargetsOf(flow)).toEqual([]);
    expect(flow.groups.some((g) => g.name === STILL_HELD_GROUP_LABEL)).toBe(false);
  });

  it("falls back to an em-dash for a blank account name", () => {
    const data = heldData();
    data.accounts.push(
      { id: 8, name: "   ", kind: "offbudget", groupLabel: "Investments", balance: "25000", onBudget: false, sort: 7 }
    );
    data.transactions.push(
      txn("2026-06-02", "Transfer : Blank", -25000, 10, { transferAccountId: 8 })
    );
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    expect(heldTargetsOf(flow)).toEqual([{ name: "—", value: 25000 }]);
  });

  it("respects the month range, swaps reversed bounds, and skips split parents", () => {
    const data = heldData();
    setBalance(data, 6, "80000");
    setBalance(data, 7, "100000");
    data.transactions.push(
      txn("2026-05-20", "Transfer : RRSP", -30000, 10, { transferAccountId: 6 }),
      txn("2026-06-02", "Transfer : RRSP", -50000, 10, { transferAccountId: 6 }),
      txn("2026-06-10", "Transfer : TFSA", -90000, 10, { transferAccountId: 7 })
    );
    const parent = txn("2026-06-11", "Split", -10000, null, { transferAccountId: 7 });
    data.transactions.push(
      parent,
      txn("2026-06-11", "Split child", -10000, 10, { parentId: parent.id, transferAccountId: 7 })
    );
    // June only: RRSP $500, TFSA $900 + $100 split child (the split parent
    // moves no money itself).
    expect(
      heldTargetsOf(computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories"))
    ).toEqual([
      { name: "TFSA", value: 100000 },
      { name: "RRSP", value: 50000 },
    ]);
    // Reversed bounds cover the same May–June span as the forward order.
    expect(
      heldTargetsOf(computeSpendingGroupFlow(data, "2026-06", "2026-05", "categories"))
    ).toEqual(heldTargetsOf(computeSpendingGroupFlow(data, "2026-05", "2026-06", "categories")));
    expect(
      heldTargetsOf(computeSpendingGroupFlow(data, "2026-05", "2026-05", "categories"))
    ).toEqual([{ name: "RRSP", value: 30000 }]);
  });

  it("sorts the Still-held pseudo-group last in Budget order (mirroring Uncategorized)", () => {
    const data = heldData();
    setBalance(data, 6, "40000");
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-02", "Transfer : RRSP", -40000, 10, { transferAccountId: 6 }),
      txn("2026-06-03", "Grocer", -30000, 10),
      txn("2026-06-04", "Corner Shop", -50000, null)
    );
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "merchants");
    const merged = mergeGroupFlow(flow.groups, flow.targets, flow.links, 0);
    const sorted = sortMergedGroupFlow(merged, ["Everyday"], "group", []);
    // Known Budget groups first; the pseudo-groups trail in current
    // (value-descending) order — Still held mirrors Uncategorized exactly.
    expect(sorted.groups.map((g) => g.name)).toEqual([
      "Everyday",
      UNCATEGORIZED_GROUP_LABEL,
      STILL_HELD_GROUP_LABEL,
    ]);
    // Held targets trail with their group: no Budget rank, value-descending
    // among the unknowns.
    expect(sorted.targets.map((t) => t.name)).toEqual(["Grocer", "Corner Shop", "RRSP"]);
  });

  it("merges a held account with a same-named spending target as one more group leg", () => {
    const data = heldData();
    setBalance(data, 6, "40000");
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-02", "Transfer : RRSP", -40000, 10, { transferAccountId: 6 }),
      txn("2026-06-03", "RRSP", -10000, 10)
    );
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "merchants");
    // One RRSP row for the total $500 flow: $100 merchant spending via
    // Everyday plus the $400 held cell via Still held (merchant-split
    // precedent — the identity reconciles cell-wise).
    expect(flow.targets).toEqual([{ name: "RRSP", value: 50000 }]);
    const legs = flow.links
      .map((l) => `${flow.groups[l.groupIndex]?.name}:${l.value}`)
      .sort();
    expect(legs).toEqual(["Everyday:10000", `${STILL_HELD_GROUP_LABEL}:40000`]);
  });

  it("draws one right-hop ribbon per cell with the Still-held group present", () => {
    const data = heldData();
    setBalance(data, 6, "40000");
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-02", "Transfer : RRSP", -40000, 10, { transferAccountId: 6 }),
      txn("2026-06-03", "Grocer", -30000, 10)
    );
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    const series = computeMonthlySankeySeries(data, "2026-06", "2026-06", "categories");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    const layout = layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
      width: 800,
      height: 400,
      leftDetail: "cells",
      leftHop: vm.left,
    });
    // One ribbon per group→target cell — the held cell included — each in
    // its target's color, and the Still-held middle bar wraps its band.
    expect(layout.linksRight).toHaveLength(vm.links.length);
    const heldLink = layout.linksRight.find((l) => l.targetName === "RRSP");
    expect(heldLink?.sourceName).toBe(STILL_HELD_GROUP_LABEL);
    expect(heldLink?.fill).toBe(layout.targets.find((t) => t.name === "RRSP")?.fill);
    const heldMid = layout.middles.find((m) => m.name === STILL_HELD_GROUP_LABEL);
    expect(heldMid?.value).toBe(40000);
    // The surplus shrinks to the on-budget leftover: $1,000 in, $300 + $400 out.
    // (Chequing nets +$300 but holds $0 at range end, so it draws no row —
    // the zero-balance fixture keeps the off-budget-only shape.)
    expect(layout.remainingTargetIndex).toBe(layout.targets.length - 1);
    expect(layout.targets[layout.remainingTargetIndex!]?.value).toBeCloseTo(30000, 9);
  });
});

describe("on-budget still-held rows", () => {
  // Task-52: on-budget accounts (EQ Bank, chequing, savings, cash…) draw
  // still-held rows just like off-budget investment accounts — same guards
  // (positive range net AND positive range-end balance), same "Still held"
  // pseudo-group, same chronological funding. With full partitioning the
  // Remaining plug normally dissolves into per-account cash rows.
  function onBudgetHeldData(): BudgetData {
    const data = makeData();
    data.accounts.push(
      { id: 5, name: "EQ Bank", kind: "liquid", groupLabel: "Budget", balance: "60000", onBudget: true, sort: 2 },
      { id: 6, name: "RRSP", kind: "offbudget", groupLabel: "Investments", balance: "40000", onBudget: false, sort: 3 }
    );
    data.transactions = [];
    return data;
  }

  // EQ-Bank-style fixture: $2,000 salary in, a $1,000 terminal purchase,
  // $600 parked in EQ Bank and $400 contributed to the RRSP — every dollar
  // spent or held. Chequing nets to exactly zero, so it draws no row.
  function eqBankData(): BudgetData {
    const data = onBudgetHeldData();
    data.transactions.push(
      txn("2026-06-01", "Payroll", 200000, null),
      txn("2026-06-05", "Grocer", -100000, 10),
      txn("2026-06-06", "Transfer : EQ Bank", -60000, null, { transferAccountId: 5 }),
      txn("2026-06-07", "Transfer : RRSP", -40000, 10, { transferAccountId: 6 })
    );
    return data;
  }

  // Held rows of a flow: targets fed ONLY through the Still-held group.
  const heldTargetsOf = (flow: SpendingGroupFlow): { name: string; value: number }[] =>
    flow.targets.filter((_, ti) => {
      const incoming = flow.links.filter((l) => l.targetIndex === ti);
      return (
        incoming.length > 0 &&
        incoming.every((l) => flow.groups[l.groupIndex]?.name === STILL_HELD_GROUP_LABEL)
      );
    });

  const fundedInto = (
    vm: ReturnType<typeof computeSankeyViewModel>,
    source: string,
    target: string
  ): number => {
    const si = vm.sources.findIndex((s) => s.name === source);
    const cis = new Set(
      vm.links
        .map((l, k) => ({ l, k }))
        .filter(({ l }) => vm.targets[l.targetIndex]?.name === target)
        .map(({ k }) => k)
    );
    return vm.left.cells
      .filter((c) => c.sourceIndex === si && cis.has(c.rightLinkIndex))
      .reduce((s, c) => s + c.value, 0);
  };

  // Independent signed nets over the report's included row set (in-range,
  // no split parents, no Starting Balance rows): each leg lands in the on-
  // or off-budget bucket by ITS account (missing accounts default
  // on-budget, matching the transfer classifiers). Transfer rows net to
  // zero across their two legs; internal on→on moves net within the on
  // bucket.
  const signedNetsOf = (
    d: BudgetData,
    start: string,
    end: string
  ): { on: number; off: number } => {
    const splitParents = new Set<number>();
    for (const t of d.transactions) {
      if (t.parentId != null) splitParents.add(t.parentId);
    }
    const onBudgetOf = new Map(d.accounts.map((a) => [a.id, a.onBudget ?? true]));
    let on = 0;
    let off = 0;
    for (const t of d.transactions) {
      if (splitParents.has(t.id)) continue;
      if (t.payee.trim() === STARTING_BALANCE_PAYEE) continue;
      const mk = t.date.slice(0, 7);
      if (mk < start || mk > end) continue;
      const amt = Number(t.amount);
      const legs: [number, number][] = [[t.accountId, amt]];
      if (t.transferAccountId != null) legs.push([t.transferAccountId, -amt]);
      for (const [id, delta] of legs) {
        if (onBudgetOf.get(id) ?? true) on += delta;
        else off += delta;
      }
    }
    return { on, off };
  };

  it("partitions income exactly into spending + on-budget held + off-budget held (no plug, both dims)", () => {
    const data = eqBankData();
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    expect(income).toEqual([{ name: "Payroll", value: 200000 }]);
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", dimension);
      // Both accounts draw as Still-held rows with their exact nets — the
      // on-budget EQ Bank row just like the off-budget RRSP one.
      expect(heldTargetsOf(flow)).toEqual([
        { name: "EQ Bank", value: 60000 },
        { name: "RRSP", value: 40000 },
      ]);
      expect(flow.groups).toContainEqual({ name: STILL_HELD_GROUP_LABEL, value: 100000 });
      const held = heldTargetsOf(flow).reduce((s, t) => s + t.value, 0);
      const spending = flow.targets.reduce((s, t) => s + t.value, 0) - held;
      expect(spending).toBe(100000);
      // income = spending + held EXACTLY: the plug dissolves.
      expect(200000 - spending - held).toBe(0);
      const series = computeMonthlySankeySeries(data, "2026-06", "2026-06", dimension);
      const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
      expect(vm.left.incomeTotal).toBe(200000);
      expect(vm.left.spendingTotal).toBeCloseTo(200000, 9);
      expect(vm.left.remainingBySource).toEqual([0]);
      // Correct funding: a single month, so Payroll funds every cell in
      // full — the purchase and both held rows.
      const purchase = dimension === "categories" ? "Groceries" : "Grocer";
      expect(fundedInto(vm, "Payroll", purchase)).toBeCloseTo(100000, 9);
      expect(fundedInto(vm, "Payroll", "EQ Bank")).toBeCloseTo(60000, 9);
      expect(fundedInto(vm, "Payroll", "RRSP")).toBeCloseTo(40000, 9);
      // No plug row survives into the geometry either.
      const layout = layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
        width: 800,
        height: 400,
        leftDetail: "cells",
        leftHop: vm.left,
      });
      expect(layout.remainingTargetIndex).toBeNull();
      // Conservation: income − spending = Σ signed on-nets + Σ off-nets.
      const { on, off } = signedNetsOf(data, "2026-06", "2026-06");
      expect(200000 - spending).toBe(on + off);
      expect(on).toBe(60000);
      expect(off).toBe(40000);
    }
  });

  it("excludes a credit card carrying a balance (purchases still show as spending)", () => {
    const data = makeData();
    data.accounts.push(
      { id: 3, name: "Visa", kind: "credit", groupLabel: "Credit", balance: "-50000", onBudget: true, sort: 2 }
    );
    data.transactions = [
      txn("2026-06-01", "Payroll", 200000, null),
      txn("2026-06-08", "Whole Foods", -80000, 10, { accountId: 3 }),
      txn("2026-06-15", "Transfer : Visa", -30000, null, { transferAccountId: 3 }),
    ];
    // Visa nets −$500 ($800 out, $300 payoff back) with a negative
    // range-end balance: liability, never holdings. Chequing nets +$1,700
    // but holds $0 at range end: no row either.
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", dimension);
      expect(flow.groups.some((g) => g.name === STILL_HELD_GROUP_LABEL)).toBe(false);
      expect(flow.targets.some((t) => t.name === "Visa")).toBe(false);
      expect(flow.targets.some((t) => t.name === "Chequing")).toBe(false);
    }
    // The card purchase is still the one spending record.
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "categories")).toEqual([
      { name: "Groceries", value: 80000 },
    ]);
    expect(computeSpendingBreakdown(data, "2026-06", "2026-06", "merchants")).toEqual([
      { name: "Whole Foods", value: 80000 },
    ]);
    // …and the uncovered $1,200 stays a Remaining plug, not phantom holdings.
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", "categories");
    const series = computeMonthlySankeySeries(data, "2026-06", "2026-06", "categories");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    expect(vm.left.remainingBySource).toEqual([120000]);
  });

  it("creates no held rows for an on→on round-trip (movement, not holdings)", () => {
    const data = onBudgetHeldData();
    data.transactions.push(
      txn("2026-06-01", "Payroll", 100000, null),
      txn("2026-06-03", "Transfer : EQ Bank", -50000, null, { transferAccountId: 5 }),
      txn("2026-06-20", "Transfer : Chequing", -50000, null, { accountId: 5, transferAccountId: 1 }),
      txn("2026-06-21", "Grocer", -100000, 10)
    );
    // Both legs net to zero per account (chequing −$500/+$500, EQ Bank
    // +$500/−$500) and income exactly covers spending.
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", dimension);
      expect(flow.groups.some((g) => g.name === STILL_HELD_GROUP_LABEL)).toBe(false);
      const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
      const series = computeMonthlySankeySeries(data, "2026-06", "2026-06", dimension);
      const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
      expect(vm.left.remainingBySource).toEqual([0]);
      const { on, off } = signedNetsOf(data, "2026-06", "2026-06");
      expect(on).toBe(0);
      expect(off).toBe(0);
    }
  });

  it("shifts (not creates) held money on a one-way on→on move, preserving the conservation identity", () => {
    const data = makeData();
    // Chequing holds the $500 surplus until the move; Savings after it.
    data.accounts.find((a) => a.id === 1)!.balance = "50000";
    data.accounts.find((a) => a.id === 2)!.balance = "50000";
    data.transactions = [
      txn("2026-06-01", "Payroll", 200000, null),
      txn("2026-06-05", "Grocer", -150000, 10),
    ];
    const check = (expectedHeld: { name: string; value: number }[]) => {
      for (const dimension of ["categories", "merchants"] as const) {
        const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", dimension);
        expect(heldTargetsOf(flow)).toEqual(expectedHeld);
        const held = heldTargetsOf(flow).reduce((s, t) => s + t.value, 0);
        const spending = flow.targets.reduce((s, t) => s + t.value, 0) - held;
        // Total held + spending is unchanged by the move (stage 1 and 2
        // both reconcile to the $2,000 income).
        expect(spending).toBe(150000);
        expect(held).toBe(50000);
        // Conservation: income − spending = Σ signed on-nets + Σ off-nets.
        const { on, off } = signedNetsOf(data, "2026-06", "2026-06");
        expect(200000 - spending).toBe(on + off);
        expect(off).toBe(0);
        const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
        const series = computeMonthlySankeySeries(data, "2026-06", "2026-06", dimension);
        const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
        expect(vm.left.remainingBySource).toEqual([0]);
      }
    };
    // Stage 1: Chequing holds the $500 surplus (net +$500, balance $500).
    check([{ name: "Chequing", value: 50000 }]);
    // Stage 2: the one-way move shifts the $500 to Savings — Chequing nets
    // to zero (no row) and Savings holds it. Nothing is created.
    data.transactions.push(
      txn("2026-06-10", "Transfer : Savings", -50000, null, { transferAccountId: 2 })
    );
    check([{ name: "Savings", value: 50000 }]);
  });

  it("keeps partial-range spending from pre-range savings on the over-income path (no phantom held rows)", () => {
    const data = makeData();
    // Chequing holds $500 at range end — pre-range savings partially spent —
    // but its in-range net is negative, so a positive balance alone draws
    // no row.
    data.accounts.find((a) => a.id === 1)!.balance = "50000";
    data.transactions = [txn("2026-06-05", "Grocer", -30000, 10)];
    expect(computeIncomeBreakdown(data, "2026-06", "2026-06")).toEqual([]);
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", dimension);
      expect(flow.groups.some((g) => g.name === STILL_HELD_GROUP_LABEL)).toBe(false);
      expect(flow.targets).toHaveLength(1);
      const series = computeMonthlySankeySeries(data, "2026-06", "2026-06", dimension);
      const vm = computeSankeyViewModel(flow, [], series, { thresholdCents: 0 });
      // The existing shortfall path: no funding cells at all (Over
      // income), and no plug — money is not invented.
      expect(vm.left.incomeTotal).toBe(0);
      expect(vm.left.spendingTotal).toBeCloseTo(30000, 9);
      expect(vm.left.cells).toEqual([]);
      expect(vm.left.remainingBySource).toEqual([]);
      expect(vm.left.incomeTotal - vm.left.spendingTotal).toBeCloseTo(-30000, 9);
      const layout = layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
        width: 800,
        height: 400,
        leftDetail: "cells",
        leftHop: vm.left,
      });
      expect(layout.remainingTargetIndex).toBeNull();
    }
  });

  it("renders no plug when partitioning is complete (Left reconciles to exactly $0)", () => {
    const data = eqBankData();
    const income = computeIncomeBreakdown(data, "2026-06", "2026-06");
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, "2026-06", "2026-06", dimension);
      const series = computeMonthlySankeySeries(data, "2026-06", "2026-06", dimension);
      const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
      // Left = income − spending − held reconciles to exactly $0: every
      // dollar spent or held (the header clamps allocator-epsilon dust to
      // the same $0 — see SpendingReport).
      const held = heldTargetsOf(flow).reduce((s, t) => s + t.value, 0);
      const spending = flow.targets.reduce((s, t) => s + t.value, 0) - held;
      expect(vm.left.incomeTotal - spending - held).toBe(0);
      expect(vm.left.remainingBySource).toEqual([0]);
      const layout = layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
        width: 800,
        height: 400,
        leftDetail: "cells",
        leftHop: vm.left,
      });
      expect(layout.targets.some((t) => t.name === REMAINING_LABEL)).toBe(false);
      expect(layout.remainingTargetIndex).toBeNull();
    }
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
    expect(layout.remainingLaneY).toBeNull();
    expect(layout.remainingLaneOverflow).toBe(0);
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
    // Balanced: no plug, no lane — every link is a straight ribbon.
    expect(layout.remainingTargetIndex).toBeNull();
    expect(layout.remainingLaneY).toBeNull();
    expect(layout.remainingLaneOverflow).toBe(0);
    for (const l of [...layout.linksLeft, ...layout.linksRight]) {
      expect(l.ly0).toBeUndefined();
      expect(l.ly1).toBeUndefined();
    }
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
    // Full-width: runs from the source bar to the Remaining bar through
    // the dedicated lane below the middle column — and fills the plug bar
    // exactly, no taper.
    expect(plug.x0).toBeCloseTo(layout.sources[0]!.x + layout.sources[0]!.w, 6);
    expect(plug.x1).toBeCloseTo(rem.x, 6);
    expect(plug.x1).toBeGreaterThan(layout.middles[0]!.x + layout.middles[0]!.w);
    expect(plug.sy1 - plug.sy0).toBeCloseTo(plug.ty1 - plug.ty0, 6);
    expect(plug.ty0).toBeCloseTo(rem.y, 6);
    expect(plug.ty1).toBeCloseTo(rem.y + rem.h, 6);
    expect(plug.d).toMatch(/^M .* C .* Z$/);
  });

  it("routes Remaining plug ribbons through a dedicated lane below the middle column", () => {
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 9000), merged("Gig", 3000)],
      gGroups,
      gTargets,
      gLinks,
      { width: 800, height: 400, nodeGap: 8, minNodeHeight: 24 }
    );
    expect(layout.remainingTargetIndex).toBe(3);
    const lastMid = layout.middles[layout.middles.length - 1]!;
    const rem = layout.targets[3]!;
    // The lane sits one row gap below the last middle bar and fits the plot.
    expect(layout.remainingLaneY).toBeCloseTo(lastMid.y + lastMid.h + 8, 9);
    expect(layout.remainingLaneOverflow).toBe(0);
    const laneY = layout.remainingLaneY!;
    // Plug spans tile the lane in source order with no taper: the lane sums
    // to the plug bar height exactly.
    const plugs = layout.linksLeft.filter((l) => l.targetIndex === layout.middles.length);
    expect(plugs.map((l) => l.sourceIndex)).toEqual([0, 1]);
    expect(plugs[0]!.ly0).toBeCloseTo(laneY, 9);
    expect(plugs[1]!.ly0).toBeCloseTo(plugs[0]!.ly1 ?? -1, 9);
    expect(plugs[1]!.ly1).toBeCloseTo(laneY + rem.h, 9);
    for (const p of plugs) {
      expect((p.ly1 ?? 0) - (p.ly0 ?? 0)).toBeCloseTo(p.ty1 - p.ty0, 9);
      expect((p.ly1 ?? 0) - (p.ly0 ?? 0)).toBeCloseTo(p.sy1 - p.sy0, 9);
    }
    // Only plug ribbons carry lane spans; group and category ribbons stay
    // straight bar-to-bar beziers.
    for (const l of layout.linksLeft) {
      if (l.targetIndex === layout.middles.length) continue;
      expect(l.ly0).toBeUndefined();
      expect(l.ly1).toBeUndefined();
      expect(l.d.split(" L ")).toHaveLength(2);
    }
    for (const l of layout.linksRight) {
      expect(l.ly0).toBeUndefined();
      expect(l.ly1).toBeUndefined();
    }
    // Each plug path bridges horizontally under the middle bar column: one
    // straight run per edge (three L-runs in all: bridge, target edge,
    // bridge) at the link's own lane span.
    const midX = layout.middles[0]!.x;
    const laneX1 = midX + layout.middles[0]!.w;
    for (const p of plugs) {
      expect(p.d.split(" L ")).toHaveLength(4);
      expect(p.d).toContain(`L ${laneX1.toFixed(2)} ${(p.ly0 ?? 0).toFixed(2)}`);
      expect(p.d).toContain(`L ${midX.toFixed(2)} ${(p.ly1 ?? 0).toFixed(2)}`);
    }
  });

  it("keeps plug ribbons clear of every bar and every middle→target ribbon", () => {
    // Lower-middle-to-top-target cell (G2→A) crosses the G1 legs in the
    // right half, so the traverse proves itself against a crossed envelope.
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 12000), merged("Gig", 3000)],
      [merged("G1", 6000), merged("G2", 4000)],
      [merged("A", 5000), merged("B", 3000), merged("C", 2000)],
      [
        { groupIndex: 0, targetIndex: 0, value: 4000 },
        { groupIndex: 0, targetIndex: 1, value: 2000 },
        { groupIndex: 1, targetIndex: 0, value: 1000 },
        { groupIndex: 1, targetIndex: 1, value: 1000 },
        { groupIndex: 1, targetIndex: 2, value: 2000 },
      ],
      {
        width: 1000,
        height: 600,
        padLeft: 160,
        padRight: 190,
        padTop: 28,
        padBottom: 28,
        nodeGap: 8,
        minNodeHeight: 24,
      }
    );
    expect(layout.remainingTargetIndex).toBe(3);
    expect(layout.remainingLaneOverflow).toBe(0);
    type Seg = { cmd: string; pts: number[] };
    const parseD = (d: string): Seg[] => {
      const tokens = d.trim().split(/\s+/);
      const segs: Seg[] = [];
      let i = 0;
      while (i < tokens.length) {
        const cmd = tokens[i++]!;
        if (cmd === "Z") break;
        const count = cmd === "C" ? 6 : 2;
        segs.push({ cmd, pts: tokens.slice(i, i + count).map(Number) });
        i += count;
      }
      return segs;
    };
    const cubic = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
      const u = 1 - t;
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    };
    // Dense outline samples for one closed path (every cubic at 41 taps
    // plus every line endpoint): bar interiors must contain none of them.
    const outline = (d: string): { x: number; y: number }[] => {
      const pts: { x: number; y: number }[] = [];
      let cx = 0;
      let cy = 0;
      for (const s of parseD(d)) {
        if (s.cmd === "M" || s.cmd === "L") {
          cx = s.pts[0]!;
          cy = s.pts[1]!;
          pts.push({ x: cx, y: cy });
        } else if (s.cmd === "C") {
          const [x1, y1, x2, y2, ex, ey] = s.pts as [number, number, number, number, number, number];
          for (let k = 1; k <= 40; k++) {
            const t = k / 40;
            pts.push({ x: cubic(cx, x1, x2, ex, t), y: cubic(cy, y1, y2, ey, t) });
          }
          cx = ex;
          cy = ey;
        }
      }
      return pts;
    };
    const bars = [...layout.sources, ...layout.middles, ...layout.targets];
    const plugs = layout.linksLeft.filter((l) => l.targetIndex === layout.middles.length);
    expect(plugs.length).toBeGreaterThan(0);
    for (const p of plugs) {
      // No plug outline point sits strictly inside any bar rect: bands may
      // touch bar edges (tiling) but never enter them.
      for (const pt of outline(p.d)) {
        for (const b of bars) {
          const inside =
            pt.x > b.x + 1e-6 && pt.x < b.x + b.w - 1e-6 && pt.y > b.y + 1e-6 && pt.y < b.y + b.h - 1e-6;
          expect(inside).toBe(false);
        }
      }
      // The traverse shares the right-hop x-range and curve family
      // exactly: same start/end x and same control-x on every curve, so
      // equal-t samples are equal-x stations on both sides.
      const pSegs = parseD(p.d);
      expect(pSegs.map((s) => s.cmd)).toEqual(["M", "C", "L", "C", "L", "C", "L", "C"]);
      const trav = pSegs[3]!;
      const travStartX = pSegs[2]!.pts[0]!;
      const travEndX = trav.pts[4]!;
      for (const r of layout.linksRight) {
        const rSegs = parseD(r.d);
        expect(rSegs.map((s) => s.cmd)).toEqual(["M", "C", "L", "C"]);
        const bottom = rSegs[3]!;
        // Same x-parameterization: identical x0, control-x pair, and x1
        // (the bottom edge runs back right-to-left, so its endpoint is x0).
        expect(rSegs[0]!.pts[0]).toBeCloseTo(travStartX, 9);
        expect(rSegs[2]!.pts[0]).toBeCloseTo(travEndX, 9);
        expect(bottom.pts[0]).toBeCloseTo(trav.pts[0] ?? 0, 9);
        expect(bottom.pts[2]).toBeCloseTo(trav.pts[2] ?? 0, 9);
        expect(bottom.pts[4]).toBeCloseTo(travStartX, 9);
        // The plug's top edge stays below every category ribbon's bottom
        // edge at every station — the convex-combination proof, sampled.
        // (The bottom edge is read in forward left-to-right form by cubic
        // reversal symmetry, so equal-t samples are equal-x stations.)
        const rEndY = rSegs[2]!.pts[1]!;
        const rStartY = bottom.pts[5]!;
        for (let k = 0; k <= 100; k++) {
          const t = k / 100;
          const plugY = cubic(p.ly0 ?? 0, trav.pts[1] ?? 0, trav.pts[3] ?? 0, p.ty0, t);
          const catY = cubic(rStartY, rStartY, rEndY, rEndY, t);
          expect(plugY).toBeGreaterThanOrEqual(catY - 1e-6);
        }
      }
    }
  });

  it("reports lane overflow past the plot bottom for middle-heavy flows, keeping bars put", () => {
    // Six groups into two targets with a surplus: the middle column hangs
    // below the last spending target, so the lane needs canvas past the
    // plot bottom. The lane is transit-only — bars keep their stacked spots.
    const groups = [
      merged("G1", 2000),
      merged("G2", 2000),
      merged("G3", 2000),
      merged("G4", 2000),
      merged("G5", 1000),
      merged("G6", 1000),
    ];
    const H = 400;
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 15000)],
      groups,
      [merged("A", 6000), merged("B", 4000)],
      [
        { groupIndex: 0, targetIndex: 0, value: 2000 },
        { groupIndex: 1, targetIndex: 0, value: 2000 },
        { groupIndex: 2, targetIndex: 0, value: 2000 },
        { groupIndex: 3, targetIndex: 1, value: 2000 },
        { groupIndex: 4, targetIndex: 1, value: 1000 },
        { groupIndex: 5, targetIndex: 1, value: 1000 },
      ],
      {
        width: 1000,
        height: H,
        padLeft: 160,
        padRight: 190,
        padTop: 28,
        padBottom: 28,
        nodeGap: 8,
        minNodeHeight: 24,
      }
    );
    expect(layout.remainingTargetIndex).toBe(2);
    const lastMid = layout.middles[layout.middles.length - 1]!;
    const spendLast = layout.targets[layout.targets.length - 2]!;
    const plugBar = layout.targets[layout.targets.length - 1]!;
    // Middle-heavy, confirmed: the middle column ends below the last
    // spending bar, and the plug bar keeps its stacked trailing spot.
    expect(lastMid.y + lastMid.h).toBeGreaterThan(spendLast.y + spendLast.h);
    expect(plugBar.y).toBeCloseTo(spendLast.y + spendLast.h + 8, 9);
    // The lane still clears the middle column — it just needs extra canvas.
    expect(layout.remainingLaneY).toBeCloseTo(lastMid.y + lastMid.h + 8, 9);
    const plugs = layout.linksLeft.filter((l) => l.targetIndex === layout.middles.length);
    expect(plugs).toHaveLength(1);
    const laneBottom = plugs[0]!.ly1 ?? 0;
    expect(laneBottom).toBeGreaterThan(H - 28);
    expect(layout.remainingLaneOverflow).toBeCloseTo(laneBottom - (H - 28), 9);
    expect(layout.remainingLaneOverflow).toBeGreaterThan(0);
    // Values untouched: the plug still carries the full surplus.
    expect(plugBar.value).toBe(5000);
    expect(plugs[0]!.value).toBe(5000);
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

  it("wraps each middle bar exactly around its outgoing bands with no slack", () => {
    // Bars wrap their bands exactly — no label minimum lifts them (the
    // legacy minNodeHeight option is ignored) and no slack survives on
    // either side: Big's bar equals its single band, and Tiny's nineteen
    // floored bands tile its bar edge to edge, contiguously.
    const small = Array.from({ length: 19 }, (_, i) => merged(`T${i}`, 10));
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 10000)],
      [merged("Big", 9810), merged("Tiny", 190)],
      [merged("A", 9810), ...small],
      [
        { groupIndex: 0, targetIndex: 0, value: 9810 },
        ...small.map((_, k) => ({ groupIndex: 1, targetIndex: k + 1, value: 10 })),
      ],
      { width: 800, height: 400, minNodeHeight: 24 }
    );
    const big = layout.middles[0]!;
    const bigBands = layout.linksRight.filter((l) => l.sourceIndex === 0);
    expect(bigBands).toHaveLength(1);
    expect(big.h).toBeCloseTo((9810 / 10000) * 270, 6);
    expect(bigBands[0]!.sy0).toBeCloseTo(big.y, 6);
    expect(bigBands[0]!.sy1).toBeCloseTo(big.y + big.h, 6);
    const tiny = layout.middles[1]!;
    const tinyBands = layout.linksRight.filter((l) => l.sourceIndex === 1);
    expect(tinyBands).toHaveLength(19);
    for (const band of tinyBands) {
      expect(band.sy1 - band.sy0).toBe(SANKEY_MIN_LINK_HEIGHT);
    }
    const tinyH = tinyBands.reduce((s, l) => s + (l.sy1 - l.sy0), 0);
    expect(tinyBands[0]!.sy0).toBeCloseTo(tiny.y, 6);
    expect(tinyH).toBeCloseTo(tiny.h, 6);
    expect(tinyBands[tinyBands.length - 1]!.sy1).toBeCloseTo(tiny.y + tiny.h, 6);
    for (let k = 1; k < tinyBands.length; k++) {
      expect(tinyBands[k]!.sy0).toBeCloseTo(tinyBands[k - 1]!.sy1, 6);
    }
  });

  it("tiles incoming bands over each middle bar exactly with no slack", () => {
    // Sibling of the outgoing-wrapping contract above: incoming bands tile
    // the bar's full height from its top edge — the bar wraps its bands,
    // so there is no lifted height to leave slack under, and the income
    // side always enters at exactly the thickness the category side
    // leaves (task-44: Housing → Mortgage Interest vs its SAP Concur
    // sub-ribbon, per color via leftCells).
    const small = Array.from({ length: 19 }, (_, i) => merged(`T${i}`, 10));
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 10000)],
      [merged("Big", 9810), merged("Tiny", 190)],
      [merged("A", 9810), ...small],
      [
        { groupIndex: 0, targetIndex: 0, value: 9810 },
        ...small.map((_, k) => ({ groupIndex: 1, targetIndex: k + 1, value: 10 })),
      ],
      { width: 800, height: 400, minNodeHeight: 24 }
    );
    for (const [i, mid] of layout.middles.entries()) {
      const inH = layout.linksLeft
        .filter((l) => l.targetIndex === i)
        .reduce((s, l) => s + (l.ty1 - l.ty0), 0);
      const outH = layout.linksRight
        .filter((l) => l.sourceIndex === i)
        .reduce((s, l) => s + (l.sy1 - l.sy0), 0);
      expect(inH).toBeCloseTo(mid.h, 6);
      expect(outH).toBeCloseTo(mid.h, 6);
    }
    const big = layout.middles[0]!;
    const inBands = layout.linksLeft.filter((l) => l.targetIndex === 0);
    expect(inBands).toHaveLength(1);
    expect(inBands[0]!.ty0).toBeCloseTo(big.y, 6);
    expect(inBands[0]!.ty1).toBeCloseTo(big.y + big.h, 6);
    // No taper: the source span matches the target span.
    expect(inBands[0]!.sy1 - inBands[0]!.sy0).toBeCloseTo(
      inBands[0]!.ty1 - inBands[0]!.ty0,
      6
    );
    // Sources still wrap their bands: every band sits inside its bar.
    for (const link of layout.linksLeft) {
      const src = layout.sources[link.sourceIndex]!;
      expect(link.sy0).toBeGreaterThanOrEqual(src.y - 1e-9);
      expect(link.sy1).toBeLessThanOrEqual(src.y + src.h + 1e-9);
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

  it("subdivides each income band into one sub-ribbon per downstream cell with no taper", () => {
    // Two incomes funding one middle with two cells: every income→middle
    // band splits into one leftCell per cell, in cell order, tiling the
    // band edge to edge. Each sub-ribbon keeps one thickness end to end,
    // carries its cell's value share, and fills with the cell's own color.
    const layout = layoutGroupedIncomeSankey(
      [merged("SAP Concur", 6000), merged("Payroll", 4000)],
      [merged("Housing", 10000)],
      [merged("Mortgage Interest", 7000), merged("Closing Costs", 3000)],
      [
        { groupIndex: 0, targetIndex: 0, value: 7000 },
        { groupIndex: 0, targetIndex: 1, value: 3000 },
      ],
      { width: 800, height: 400, leftDetail: "cells" }
    );
    expect(layout.linksRight).toHaveLength(2);
    expect(layout.leftCells).toHaveLength(4);
    for (const sub of layout.leftCells) {
      // No taper, exact cell color, and a closed left-to-right path.
      expect(sub.sy1 - sub.sy0).toBeCloseTo(sub.ty1 - sub.ty0, 6);
      const cell = layout.linksRight[sub.rightLinkIndex]!;
      expect(sub.fill).toBe(cell.fill);
      expect(sub.value).toBeGreaterThan(0);
      expect(sub.d).toMatch(/^M .* C .* Z$/);
    }
    // Siblings tile each source band edge to edge in cell order.
    for (const band of layout.linksLeft) {
      const subs = layout.leftCells.filter(
        (c) => c.sourceIndex === band.sourceIndex && c.middleIndex === band.targetIndex
      );
      expect(subs.map((s) => s.targetIndex)).toEqual([0, 1]);
      expect(subs[0]!.sy0).toBeCloseTo(band.sy0, 6);
      expect(subs[1]!.sy0).toBeCloseTo(subs[0]!.sy1, 6);
      expect(subs[1]!.sy1).toBeCloseTo(band.sy1, 6);
    }
    // Values conserve both ways: each cell's subs sum to the cell, each
    // band's subs sum to the band.
    for (const cell of layout.linksRight) {
      const sum = layout.leftCells
        .filter((c) => c.rightLinkIndex === layout.linksRight.indexOf(cell))
        .reduce((s, c) => s + c.value, 0);
      expect(sum).toBeCloseTo(cell.value, 6);
    }
    for (const band of layout.linksLeft) {
      const sum = layout.leftCells
        .filter((c) => c.sourceIndex === band.sourceIndex && c.middleIndex === band.targetIndex)
        .reduce((s, c) => s + c.value, 0);
      expect(sum).toBeCloseTo(band.value, 6);
    }
  });

  it("lands each color as one contiguous block at the outgoing cell's thickness", () => {
    // The per-color conservation contract (task-44: SAP Concur → Housing
    // vs Housing → Mortgage Interest): every income's slice of a cell lands
    // adjacent to the other incomes' slices of the same cell, so each color
    // enters the middle as ONE contiguous block at exactly the thickness
    // its cell leaves it — never thinner on the way in.
    const layout = layoutGroupedIncomeSankey(
      [merged("SAP Concur", 6000), merged("Payroll", 4000)],
      [merged("Housing", 10000)],
      [merged("Mortgage Interest", 7000), merged("Closing Costs", 3000)],
      [
        { groupIndex: 0, targetIndex: 0, value: 7000 },
        { groupIndex: 0, targetIndex: 1, value: 3000 },
      ],
      { width: 800, height: 400, leftDetail: "cells" }
    );
    const byFill = new Map<string, { y0: number; y1: number }[]>();
    for (const sub of layout.leftCells) {
      const slots = byFill.get(sub.fill) ?? [];
      slots.push({ y0: sub.ty0, y1: sub.ty1 });
      byFill.set(sub.fill, slots);
    }
    expect(byFill.size).toBe(2);
    for (const [fill, slots] of byFill) {
      slots.sort((a, b) => a.y0 - b.y0);
      for (let k = 1; k < slots.length; k++) {
        expect(slots[k]!.y0).toBeCloseTo(slots[k - 1]!.y1, 6);
      }
      const blockH = slots[slots.length - 1]!.y1 - slots[0]!.y0;
      const cell = layout.linksRight.find((l) => l.fill === fill)!;
      expect(blockH).toBeCloseTo(cell.sy1 - cell.sy0, 6);
    }
    // The blocks tile the middle's incoming stack in outgoing cell order.
    const mid = layout.middles[0]!;
    const blocks = layout.linksRight.map((cell) => {
      const slots = (byFill.get(cell.fill) ?? []).sort((a, b) => a.y0 - b.y0);
      return { y0: slots[0]!.y0, y1: slots[slots.length - 1]!.y1 };
    });
    expect(blocks[0]!.y0).toBeCloseTo(mid.y, 6);
    expect(blocks[1]!.y0).toBeCloseTo(blocks[0]!.y1, 6);
    expect(blocks[1]!.y1).toBeCloseTo(mid.y + mid.h, 6);
  });

  it("keeps plug bands whole and emits no leftCells in bands mode", () => {
    // Surplus income: the group band subdivides, but the full-width
    // Remaining band has no downstream cell and stays whole. The default
    // bands detail (Merchants grouping) emits no subdivision at all.
    const args = [
      [merged("Pay", 12000)],
      [merged("G", 10000)],
      [merged("A", 10000)],
      [{ groupIndex: 0, targetIndex: 0, value: 10000 }],
    ] as const;
    const cells = layoutGroupedIncomeSankey(args[0], args[1], args[2], [...args[3]], {
      width: 800,
      height: 400,
      leftDetail: "cells",
    });
    expect(cells.linksLeft).toHaveLength(2);
    expect(cells.leftCells).toHaveLength(1);
    expect(cells.leftCells[0]).toMatchObject({ sourceIndex: 0, middleIndex: 0 });
    const bands = layoutGroupedIncomeSankey(args[0], args[1], args[2], [...args[3]], {
      width: 800,
      height: 400,
    });
    expect(bands.leftCells).toEqual([]);
  });

  it("meets every bar segment to its ribbon through sourceFills and middleFills", () => {
    // The layout resolves each bar's gradient stops from the same spans
    // the ribbons draw, so rendering maps them to gradient elements
    // verbatim and every segment meets its ribbon pixel for pixel.
    const layout = layoutGroupedIncomeSankey(
      [merged("SAP Concur", 6000), merged("Payroll", 4000)],
      [merged("Housing", 10000)],
      [merged("Mortgage Interest", 7000), merged("Closing Costs", 3000)],
      [
        { groupIndex: 0, targetIndex: 0, value: 7000 },
        { groupIndex: 0, targetIndex: 1, value: 3000 },
      ],
      { width: 800, height: 400, leftDetail: "cells" }
    );
    const mortgage = layout.targets[0]!.fill;
    const closing = layout.targets[1]!.fill;
    // Income bars: per-cell slices in band order (SAP Concur's two cells,
    // then Payroll's), with hard edges on the shared boundaries.
    expect(layout.sourceFills).toHaveLength(2);
    for (const [i, bar] of layout.sources.entries()) {
      const stops = layout.sourceFills[i]!;
      expect(stops.map((s) => s.color)).toEqual([mortgage, mortgage, closing, closing]);
      const subs = layout.leftCells.filter((c) => c.sourceIndex === i);
      subs.forEach((sub, k) => {
        expect(bar.y + stops[2 * k]!.offset * bar.h).toBeCloseTo(sub.sy0, 6);
        expect(bar.y + stops[2 * k + 1]!.offset * bar.h).toBeCloseTo(sub.sy1, 6);
      });
    }
    // Middle bars: one segment per outgoing cell, meeting each ribbon.
    expect(layout.middleFills).toHaveLength(1);
    const midStops = layout.middleFills[0]!;
    expect(midStops.map((s) => s.color)).toEqual([mortgage, mortgage, closing, closing]);
    const mid = layout.middles[0]!;
    layout.linksRight.forEach((cell, k) => {
      expect(mid.y + midStops[2 * k]!.offset * mid.h).toBeCloseTo(cell.sy0, 6);
      expect(mid.y + midStops[2 * k + 1]!.offset * mid.h).toBeCloseTo(cell.sy1, 6);
    });
  });

  it("serializes deterministically to reproducible layout objects", () => {
    // Math-first contract: equal inputs produce identical JSON, and the
    // JSON round-trips losslessly — a glitch report can pin the exact
    // objects, and rendering reads them verbatim.
    const build = () =>
      layoutGroupedIncomeSankey(
        [merged("SAP Concur", 6000), merged("Payroll", 4000)],
        [merged("Housing", 10000)],
        [merged("Mortgage Interest", 7000), merged("Closing Costs", 3000)],
        [
          { groupIndex: 0, targetIndex: 0, value: 7000 },
          { groupIndex: 0, targetIndex: 1, value: 3000 },
        ],
        { width: 800, height: 400, leftDetail: "cells" }
      );
    const a = JSON.stringify(build());
    const b = JSON.stringify(build());
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual(JSON.parse(b));
    expect(JSON.parse(a)).toEqual(build());
  });

  it("sizes shortfall bars to their funded bands with only the link floor below", () => {
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
    // the band visibility floor (not a label minimum) holds it at a
    // hairline; A keeps its exact funded height.
    const [a, b] = [layout.targets[0]!, layout.targets[1]!];
    expect(b.h).toBe(SANKEY_MIN_LINK_HEIGHT);
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

  it("never steals from large bars: every bar keeps its absolute funded height", () => {
    // Near-full coverage (99%) with a long tiny tail: nothing is taken
    // from large bars to fund small ones — the largest flow always draws
    // the largest bar, and the layout reports its canvas need instead of
    // crushing rows to fit the plot.
    const targets = [merged("Big", 9100)];
    for (let i = 0; i < 9; i++) targets.push(merged(`T${i}`, 100));
    const layout = layoutGroupedIncomeSankey(
      [merged("Pay", 9900)],
      [merged("G", 10000)],
      targets,
      targets.map((t, j) => ({ groupIndex: 0, targetIndex: j, value: t.value })),
      { width: 800, height: 400, minNodeHeight: 24 }
    );
    // Every bar is exactly its funded share of the band — the donor keeps
    // its absolute flow height and the tail keeps its own.
    const bandH = 400 - 8 - 8 - 6 * (10 - 1);
    expect(layout.targets[0]!.h).toBeCloseTo(((9100 * 0.99) / 10000) * bandH, 6);
    for (const tgt of layout.targets.slice(1)) {
      expect(tgt.h).toBeCloseTo(((100 * 0.99) / 10000) * bandH, 6);
    }
    expect(
      layout.targets.slice(1).every((t) => t.h < layout.targets[0]!.h)
    ).toBe(true);
    // Bands fill each bar exactly, and the column bottom plus the pad is
    // exactly the reported canvas need.
    for (const tgt of layout.targets) {
      const inH = layout.linksRight
        .filter((l) => l.targetIndex === layout.targets.indexOf(tgt))
        .reduce((s, l) => s + (l.ty1 - l.ty0), 0);
      expect(inH).toBeCloseTo(tgt.h, 6);
    }
    const last = layout.targets[layout.targets.length - 1]!;
    expect(layout.contentHeight).toBeCloseTo(last.y + last.h + 8, 6);
  });

  it("renders zero-height bars with pitch-separated labels when there is no income", () => {
    const layout = layoutGroupedIncomeSankey([], gGroups, gTargets, gLinks, {
      width: 800,
      height: 400,
    });
    expect(layout.sources).toEqual([]);
    expect(layout.linksLeft).toEqual([]);
    expect(layout.linksRight).toEqual([]);
    // Zero flow renders zero-height bars with no unfunded segment and no
    // ribbons; labels still show via the reserved pitch, one slot apart.
    for (const col of [layout.middles, layout.targets]) {
      for (const node of col) {
        expect(node.fundedValue).toBe(0);
        expect(node.unfundedValue).toBe(node.value);
        expect(node.unfundedH).toBe(0);
        expect(node.h).toBe(0);
        expect(Number.isFinite(node.y)).toBe(true);
        expect(Number.isFinite(node.labelY)).toBe(true);
      }
      for (let i = 1; i < col.length; i++) {
        expect(col[i]!.labelY - col[i - 1]!.labelY).toBeCloseTo(SANKEY_MIN_PITCH, 6);
      }
    }
    // Labels anchor the minimum offset below each row top.
    expect(layout.middles[0]!.labelY).toBeCloseTo(
      layout.middles[0]!.y + SANKEY_LABEL_CENTER_MIN,
      6
    );
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
    // No middle column to bypass: no lane, and the plug ribbon stays a
    // straight bar-to-bar bezier (one L-run: the target edge).
    expect(layout.remainingLaneY).toBeNull();
    expect(layout.remainingLaneOverflow).toBe(0);
    expect(layout.linksLeft[0]!.ly0).toBeUndefined();
    expect(layout.linksLeft[0]!.ly1).toBeUndefined();
    expect(layout.linksLeft[0]!.d.split(" L ")).toHaveLength(2);
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

describe("remainingLanePath", () => {
  it("drops from the source band into the lane, bridges, then traverses to the target", () => {
    const d = remainingLanePath(10, 50, 60, 100, 20, 40, 100, 120, 200, 220);
    // Drop/traverse midpoints at 30/80; every joint carries horizontal
    // tangents, so the three runs join smoothly.
    expect(d).toBe(
      "M 10.00 20.00 " +
        "C 30.00 20.00 30.00 100.00 50.00 100.00 " +
        "L 60.00 100.00 " +
        "C 80.00 100.00 80.00 200.00 100.00 200.00 " +
        "L 100.00 220.00 " +
        "C 80.00 220.00 80.00 120.00 60.00 120.00 " +
        "L 50.00 120.00 " +
        "C 30.00 120.00 30.00 40.00 10.00 40.00 Z"
    );
  });

  it("stays a finite closed path on degenerate input (never NaN)", () => {
    for (const d of [
      remainingLanePath(0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
      remainingLanePath(100, 50, 60, 10, 20, 20, 100, 100, 200, 200),
    ]) {
      expect(d).toMatch(/^M .* C .* Z$/);
      expect(d).not.toContain("NaN");
      expect(d.split(" L ")).toHaveLength(4);
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

describe("sankey layout nodes carry no vestigial flags", () => {
  it("emits bars without a transfer flag on any column", () => {
    const layout = layoutGroupedIncomeSankey(
      [
        { name: "Payroll", value: 200000, mergedCount: 1 },
        { name: "Withdrawal", value: 50000, mergedCount: 1 },
      ],
      [{ name: "Everyday", value: 100000, mergedCount: 1 }],
      [
        { name: "Groceries", value: 70000, mergedCount: 1 },
        { name: "Moved Out", value: 30000, mergedCount: 1 },
      ],
      [
        { groupIndex: 0, targetIndex: 0, value: 70000 },
        { groupIndex: 0, targetIndex: 1, value: 30000 },
      ],
      { width: 800, height: 400 }
    );
    for (const node of [...layout.sources, ...layout.middles, ...layout.targets]) {
      expect(node).not.toHaveProperty("transfer");
    }
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
    // No stop fits 200px (the fat $500 cells and the Remaining lane bind
    // every layout), so the fallback picks the smallest contentHeight: $50
    // (7 income rows) beats both the unmerged $0 and the over-merged $100,
    // whose shorter column rescales every bar fatter.
    expect(sankeyAutoFitThreshold(groups, twoTargets, twoLinks, manyIncome, stops, 200)).toBe(
      50
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

describe("subdivideBandByValues", () => {
  it("splits a band into proportional spans in input order", () => {
    // A $100 band over $50/$30/$20 cells: spans tile [10, 110] exactly —
    // each span's height is its share of the band, in cell order.
    const spans = subdivideBandByValues([10, 110], [5000, 3000, 2000]);
    expect(spans).toHaveLength(3);
    expect(spans[0]).toEqual({ y0: 10, y1: 60, valueIndex: 0 });
    expect(spans[1]).toEqual({ y0: 60, y1: 90, valueIndex: 1 });
    expect(spans[2]).toEqual({ y0: 90, y1: 110, valueIndex: 2 });
  });

  it("snaps the last span to the band edge and skips non-positive cells", () => {
    // Float shares (1/3 each) still tile edge to edge: the last span ends
    // exactly at y1, and the skipped zero/negative cells vanish while the
    // survivors keep their input indices for color lookup.
    const spans = subdivideBandByValues([0, 90], [1, 0, 1, -5, 1]);
    expect(spans.map((s) => s.valueIndex)).toEqual([0, 2, 4]);
    expect(spans[0]!.y0).toBe(0);
    expect(spans[2]!.y1).toBe(90);
    expect(spans[1]!.y0).toBe(spans[0]!.y1);
    expect(spans[2]!.y0).toBe(spans[1]!.y1);
    expect(spans[0]!.y1 - spans[0]!.y0).toBeCloseTo(30, 9);
  });

  it("returns no spans when nothing can split", () => {
    // Empty, all non-positive, zero-total, and zero-height inputs all yield
    // [] so the caller falls back to the whole band in the group color.
    expect(subdivideBandByValues([0, 100], [])).toEqual([]);
    expect(subdivideBandByValues([0, 100], [0, -3])).toEqual([]);
    expect(subdivideBandByValues([50, 50], [5000])).toEqual([]);
    expect(subdivideBandByValues([80, 20], [5000])).toEqual([]);
  });
});
