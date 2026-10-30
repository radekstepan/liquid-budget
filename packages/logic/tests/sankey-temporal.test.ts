import { describe, expect, it } from "vitest";
import {
  allocateCellFunding,
  computeIncomeBreakdown,
  computeMonthlySankeySeries,
  computeSankeyViewModel,
  computeSpendingGroupFlow,
  layoutGroupedIncomeSankey,
  mergeBelowThreshold,
  mergeGroupFlow,
  sankeyAutoFitThreshold,
  sortMergedGroupFlow,
  SANKEY_FUNDING_EPSILON_CENTS,
  SANKEY_NODE_GAP,
  SANKEY_PAD_BOTTOM,
  SANKEY_PAD_TOP,
  SANKEY_SOURCE_GUTTER,
  type MonthlySankeySeries,
} from "../src/sankey.js";
import type { BudgetData, Transaction } from "../src/types.js";

/**
 * Temporal attribution (task-47): the report-wide fungible pro-rata left hop
 * connected every income source to every group, so hovering a merchant
 * spotlighted income it could never have been funded by. The reported case:
 * merchant "Realstar" (rent paid 2020+, group Needs) highlighted income
 * "Redman Technology" (payroll received 2014-2015, fully spent by early 2016)
 * — disjoint timelines, so the attribution is impossible.
 *
 * The fixture below is a synthetic miniature of exactly that shape: one group
 * ("Needs") spanning two eras, an early income fully consumed by early
 * spending, and late spending funded by late income. Time-aware attribution
 * must sever the cross-era links while keeping the within-era ones.
 */

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

function baseData(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget", balance: "0", onBudget: true, sort: 0 },
    ],
    groups: [{ id: 1, name: "Needs", sort: 0, isCreditCardPayments: false }],
    categories: [
      { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      { id: 11, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [],
    recurring: [],
  };
}

/** The Realstar/Redman shape: early income consumed early, late spending funded late. */
function disjointErasData(): BudgetData {
  const data = baseData();
  data.transactions = [
    txn("2015-06-15", "Early Employer", 500000, null),
    txn("2015-07-05", "Corner Store", -500000, 10),
    txn("2020-03-05", "New Payroll", 300000, null),
    txn("2020-04-01", "Late Landlord", -300000, 11),
  ];
  return data;
}

const START = "2015-01";
const END = "2020-12";

function fundingOf(
  vm: ReturnType<typeof computeSankeyViewModel>,
  sourceName: string,
  targetName: string
): number {
  const s = vm.sources.findIndex((x) => x.name === sourceName);
  const t = vm.targets.findIndex((x) => x.name === targetName);
  let sum = 0;
  for (const c of vm.left.cells) {
    if (c.sourceIndex !== s) continue;
    const link = vm.links[c.rightLinkIndex];
    if (link && link.targetIndex === t) sum += c.value;
  }
  return sum;
}

describe("sankey temporal attribution", () => {
  it("severs the impossible cross-era link in the merchant view (Realstar/Redman)", () => {
    const data = disjointErasData();
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "merchants");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });

    // The late merchant routes through Needs, which the early income also
    // funded — but only for the early merchant. The late merchant's cells
    // must carry no early money.
    expect(fundingOf(vm, "Early Employer", "Late Landlord")).toBe(0);
    expect(fundingOf(vm, "New Payroll", "Corner Store")).toBe(0);
    // Positive controls: each era funds its own spending in full.
    expect(fundingOf(vm, "Early Employer", "Corner Store")).toBeCloseTo(500000, 6);
    expect(fundingOf(vm, "New Payroll", "Late Landlord")).toBeCloseTo(300000, 6);
  });

  it("severs the impossible cross-era link in the categories view too", () => {
    const data = disjointErasData();
    const flow = computeSpendingGroupFlow(data, START, END, "categories");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "categories");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });

    expect(fundingOf(vm, "Early Employer", "Rent")).toBe(0);
    expect(fundingOf(vm, "New Payroll", "Groceries")).toBe(0);
    expect(fundingOf(vm, "Early Employer", "Groceries")).toBeCloseTo(500000, 6);
    expect(fundingOf(vm, "New Payroll", "Rent")).toBeCloseTo(300000, 6);
  });

  it("draws no sub-ribbon from the early income to the late merchant", () => {
    const data = disjointErasData();
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "merchants");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    const layout = layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
      width: 800,
      height: 400,
      padLeft: SANKEY_SOURCE_GUTTER,
      padRight: 190,
      padTop: SANKEY_PAD_TOP,
      padBottom: SANKEY_PAD_BOTTOM,
      nodeGap: SANKEY_NODE_GAP,
      leftDetail: "cells",
      leftHop: vm.left,
    });
    // The early band into Needs exists (it funds the early merchant) but
    // carries no late-colored slice.
    const earlyBand = layout.linksLeft.filter((l) => l.sourceName === "Early Employer");
    expect(earlyBand.length).toBeGreaterThan(0);
    const bad = layout.leftCells.filter(
      (c) => c.sourceName === "Early Employer" && c.targetName === "Late Landlord"
    );
    expect(bad).toHaveLength(0);
    const good = layout.leftCells.filter(
      (c) => c.sourceName === "Early Employer" && c.targetName === "Corner Store"
    );
    expect(good).toHaveLength(1);
    expect(good[0]!.value).toBeCloseTo(500000, 6);
  });

  it("conserves money: funding plus surplus equals income, funding plus gap equals spending", () => {
    const data = disjointErasData();
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, START, END, dimension);
      const income = computeIncomeBreakdown(data, START, END);
      const series = computeMonthlySankeySeries(data, START, END, dimension);
      const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
      for (let s = 0; s < vm.sources.length; s++) {
        const out = vm.left.cells
          .filter((c) => c.sourceIndex === s)
          .reduce((sum, c) => sum + c.value, 0);
        expect(out + (vm.left.remainingBySource[s] ?? 0)).toBeCloseTo(
          vm.sources[s]!.value,
          6
        );
      }
      for (let k = 0; k < vm.links.length; k++) {
        const funded = vm.left.cells
          .filter((c) => c.rightLinkIndex === k)
          .reduce((sum, c) => sum + c.value, 0);
        expect(funded).toBeLessThanOrEqual(vm.links[k]!.value + 1e-6);
      }
      const fundedTotal = vm.left.cells.reduce((sum, c) => sum + c.value, 0);
      const remainingTotal = vm.left.remainingBySource.reduce((sum, v) => sum + v, 0);
      expect(fundedTotal + remainingTotal).toBeCloseTo(vm.left.incomeTotal, 6);
    }
  });

  it("keeps genuine savings carry: early income funds later spending when the pool never empties", () => {
    // No early spending at all: the early income sits in the pool until the
    // late merchant spends it. Severing THIS link would be wrong — saved
    // money is fungible across time.
    const data = baseData();
    data.transactions = [
      txn("2015-06-15", "Early Employer", 500000, null),
      txn("2020-04-01", "Late Landlord", -300000, 11),
    ];
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "merchants");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    expect(fundingOf(vm, "Early Employer", "Late Landlord")).toBeCloseTo(300000, 6);
    expect(vm.left.remainingBySource).toHaveLength(1);
    expect(vm.left.remainingBySource[0]).toBeCloseTo(200000, 6);
  });

  it("carries arrears forward: late income funds early spending, never over and under at once", () => {
    // Spending arrives before any income: the demand waits (backlog) and the
    // late income funds it — no unfunded gap AND no surplus plug together.
    const data = baseData();
    data.transactions = [
      txn("2015-07-05", "Corner Store", -300000, 10),
      txn("2020-03-05", "New Payroll", 300000, null),
    ];
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "merchants");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    expect(fundingOf(vm, "New Payroll", "Corner Store")).toBeCloseTo(300000, 6);
    expect(vm.left.remainingBySource.reduce((s, v) => s + v, 0)).toBeCloseTo(0, 6);
  });

  it("matches the legacy pro-rata allocation exactly on a single-month range", () => {
    // One month collapses time: pool and demand coincide, so chronological
    // funding must equal the report-wide proportional split it replaces.
    const data = baseData();
    data.transactions = [
      txn("2020-03-05", "Pay A", 600000, null),
      txn("2020-03-06", "Pay B", 400000, null),
      txn("2020-03-10", "Corner Store", -700000, 10),
      txn("2020-03-11", "Late Landlord", -300000, 11),
    ];
    const flow = computeSpendingGroupFlow(data, "2020-03", "2020-03", "merchants");
    const income = computeIncomeBreakdown(data, "2020-03", "2020-03");
    const series = computeMonthlySankeySeries(data, "2020-03", "2020-03", "merchants");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    expect(fundingOf(vm, "Pay A", "Corner Store")).toBeCloseTo(700000 * 0.6, 6);
    expect(fundingOf(vm, "Pay B", "Corner Store")).toBeCloseTo(700000 * 0.4, 6);
    expect(fundingOf(vm, "Pay A", "Late Landlord")).toBeCloseTo(300000 * 0.6, 6);
    expect(fundingOf(vm, "Pay B", "Late Landlord")).toBeCloseTo(300000 * 0.4, 6);
  });

  it("prunes float-dust slices so a decayed pool share draws and lights nothing", () => {
    // Source A arrives once, then sixty months of rival income dilute its
    // pool share geometrically (halving monthly): by the end A's slice of
    // each demand is e-16 — true pro-rata math, but no pixel and no cent.
    // Those slices must never become ribbons or hover members.
    const months = 60;
    const incomeByMonth = Array.from({ length: months }, (_, m) => [
      m === 0 ? 100 : 0,
      100,
    ]);
    const cellByMonth = Array.from({ length: months }, () => [100]);
    const result = allocateCellFunding(incomeByMonth, cellByMonth);
    for (const f of result.funding) {
      expect(f.value).toBeGreaterThanOrEqual(SANKEY_FUNDING_EPSILON_CENTS);
    }
    // A's decayed remainder snaps to exactly zero instead of lingering as
    // an e-16 surplus plug sliver.
    expect(result.remainingBySource[0]).toBe(0);
    expect(result.remainingBySource[1]).toBeCloseTo(100, 6);
    expect(result.cellUnfunded).toEqual([0]);
  });

  it("snaps repeating-decimal shortfalls to exactly zero", () => {
    // 9 × (3/9) is 8.999999999999998 in floats, not 9: the 1.8e-15 gap is
    // arithmetic residue, never an over-income slice.
    const result = allocateCellFunding([[10]], [[3, 3, 3]]);
    expect(result.cellUnfunded).toEqual([0, 0, 0]);
    expect(result.remainingBySource[0]).toBeCloseTo(1, 9);
  });

  it("tolerates empty and ragged matrices without losing conservation", () => {
    const empty = allocateCellFunding([], []);
    expect(empty.funding).toEqual([]);
    expect(empty.incomeTotal).toBe(0);
    expect(empty.spendingTotal).toBe(0);
    // Ragged rows (a short month, a missing month): missing entries read
    // as zero and both conservation identities still hold.
    const ragged = allocateCellFunding(
      [
        [100, 50],
        [25],
        [],
        [10],
      ],
      [[60], [], [10]]
    );
    expect(ragged.incomeTotal).toBeCloseTo(185, 8);
    expect(ragged.spendingTotal).toBeCloseTo(70, 8);
    const out = ragged.funding.reduce((sum, f) => sum + f.value, 0);
    expect(out).toBeCloseTo(70, 6);
    expect(ragged.remainingBySource).toHaveLength(2);
    const remainingTotal = ragged.remainingBySource.reduce((sum, v) => sum + v, 0);
    expect(remainingTotal).toBeCloseTo(115, 6);
  });
});

describe("computeMonthlySankeySeries", () => {
  it("sums each monthly column exactly to its range total, in both dimensions", () => {
    const data = disjointErasData();
    for (const dimension of ["categories", "merchants"] as const) {
      const flow = computeSpendingGroupFlow(data, START, END, dimension);
      const income = computeIncomeBreakdown(data, START, END);
      const series = computeMonthlySankeySeries(data, START, END, dimension);
      expect(series.incomeNames).toEqual(income.map((i) => i.name));
      expect(series.months).toEqual([...series.months].sort());
      expect(series.incomeByMonth).toHaveLength(series.months.length);
      expect(series.cellByMonth).toHaveLength(series.months.length);
      for (let s = 0; s < income.length; s++) {
        const col = series.incomeByMonth.reduce((sum, row) => sum + (row[s] ?? 0), 0);
        expect(col).toBeCloseTo(income[s]!.value, 8);
      }
      for (let k = 0; k < flow.links.length; k++) {
        const col = series.cellByMonth.reduce((sum, row) => sum + (row[k] ?? 0), 0);
        expect(col).toBeCloseTo(flow.links[k]!.value, 6);
      }
      for (const row of series.incomeByMonth) for (const v of row) expect(v).toBeGreaterThanOrEqual(0);
      for (const row of series.cellByMonth) for (const v of row) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("washes out refund timing while keeping the range total and the spending months", () => {
    // January spends $100, June refunds $90: the range cell is $10 and the
    // monthly shape keeps January only — a refund nets against the group's
    // spending, it never funds a June slice.
    const data = baseData();
    data.transactions = [
      txn("2020-01-10", "Flaky Store", -10000, 10),
      txn("2020-06-10", "Flaky Store", 9000, 10),
    ];
    const flow = computeSpendingGroupFlow(data, "2020-01", "2020-12", "merchants");
    expect(flow.links).toHaveLength(1);
    expect(flow.links[0]!.value).toBeCloseTo(1000, 8);
    const series = computeMonthlySankeySeries(data, "2020-01", "2020-12", "merchants");
    const jan = series.months.indexOf("2020-01");
    const jun = series.months.indexOf("2020-06");
    expect(series.cellByMonth[jan]![0]).toBeCloseTo(1000, 6);
    expect(series.cellByMonth[jun]![0]).toBe(0);
    const col = series.cellByMonth.reduce((sum, row) => sum + (row[0] ?? 0), 0);
    expect(col).toBeCloseTo(1000, 6);
  });
});

describe("computeSankeyViewModel", () => {
  it("returns exactly the merge+sort columns, so Bars and Sankey cannot disagree", () => {
    const data = disjointErasData();
    // Small rows to force real Other buckets on every column.
    data.transactions.push(
      txn("2020-04-02", "Tiny Tip", -5000, 11),
      txn("2020-03-06", " Coin Jar", 10000, null)
    );
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "merchants");
    const thresholdCents = 250000;
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents });
    const merged = mergeGroupFlow(flow.groups, flow.targets, flow.links, thresholdCents);
    const mergedIncome = mergeBelowThreshold(income, thresholdCents);
    const ordered = sortMergedGroupFlow(merged, [], "amount");
    expect(vm.sources).toEqual(mergedIncome.items);
    expect(vm.groups).toEqual(ordered.groups);
    expect(vm.targets).toEqual(ordered.targets);
    expect(vm.links).toEqual(ordered.links);
    // And the funding still conserves across the merged buckets.
    const fundedTotal = vm.left.cells.reduce((sum, c) => sum + c.value, 0);
    const remainingTotal = vm.left.remainingBySource.reduce((sum, v) => sum + v, 0);
    expect(fundedTotal + remainingTotal).toBeCloseTo(vm.left.incomeTotal, 6);
  });

  it("carries each cell's funding with it under Budget-order sorting", () => {
    const data: BudgetData = {
      ...baseData(),
      groups: [
        { id: 1, name: "Alpha", sort: 1, isCreditCardPayments: false },
        { id: 2, name: "Beta", sort: 0, isCreditCardPayments: false },
      ],
      categories: [
        { id: 10, groupId: 1, name: "Old Cat", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
        { id: 11, groupId: 2, name: "New Cat", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
      ],
      transactions: [
        txn("2015-06-15", "Early Employer", 500000, null),
        txn("2015-07-05", "Old Shop", -500000, 10),
        txn("2020-03-05", "New Payroll", 300000, null),
        txn("2020-04-01", "New Shop", -300000, 11),
      ],
    };
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "merchants");
    // Budget order puts Beta (sort 0) before Alpha (sort 1): the amount order
    // (Alpha first, 500k > 300k) permutes.
    const vm = computeSankeyViewModel(flow, income, series, {
      thresholdCents: 0,
      groupOrder: ["Beta", "Alpha"],
      sort: "group",
    });
    expect(vm.groups.map((g) => g.name)).toEqual(["Beta", "Alpha"]);
    for (const c of vm.left.cells) {
      expect(vm.sources[c.sourceIndex]).toBeDefined();
      expect(vm.links[c.rightLinkIndex]).toBeDefined();
      expect(c.value).toBeGreaterThan(0);
    }
    expect(fundingOf(vm, "Early Employer", "New Shop")).toBe(0);
    expect(fundingOf(vm, "New Payroll", "Old Shop")).toBe(0);
    expect(fundingOf(vm, "Early Employer", "Old Shop")).toBeCloseTo(500000, 6);
    expect(fundingOf(vm, "New Payroll", "New Shop")).toBeCloseTo(300000, 6);
  });

  it("attributes the surplus plug only to the incomes still in the pool", () => {
    const data = disjointErasData();
    // Extra late income nobody spends: the plug is 100% late money.
    data.transactions.push(txn("2021-02-05", "Windfall", 100000, null));
    const end = "2021-12";
    const flow = computeSpendingGroupFlow(data, START, end, "merchants");
    const income = computeIncomeBreakdown(data, START, end, "merchants");
    const series = computeMonthlySankeySeries(data, START, end, "merchants");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    const byName = new Map(vm.sources.map((s, i) => [s.name, vm.left.remainingBySource[i] ?? NaN]));
    expect(byName.get("Early Employer")).toBeCloseTo(0, 6);
    expect(byName.get("New Payroll")).toBeCloseTo(0, 6);
    expect(byName.get("Windfall")).toBeCloseTo(100000, 6);
  });

  it("leaves a fully unfunded cell out of the geometry but in the tooltip values", () => {
    // No 2020 income: the late merchant is entirely unfunded.
    const data = baseData();
    data.transactions = [
      txn("2015-06-15", "Early Employer", 500000, null),
      txn("2015-07-05", "Corner Store", -500000, 10),
      txn("2020-04-01", "Late Landlord", -300000, 11),
    ];
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "merchants");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    const layout = layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
      width: 800,
      height: 400,
      leftHop: vm.left,
    });
    const late = layout.targets.find((t) => t.name === "Late Landlord")!;
    expect(late.h).toBe(0);
    expect(late.fundedValue).toBeCloseTo(0, 6);
    expect(late.unfundedValue).toBeCloseTo(300000, 6);
    expect(layout.linksRight.filter((l) => l.targetName === "Late Landlord")).toHaveLength(0);
    const corner = layout.targets.find((t) => t.name === "Corner Store")!;
    expect(corner.fundedValue).toBeCloseTo(500000, 6);
  });

  it("stays degenerate-safe on empty data: no funding, no nodes, no crash", () => {
    const data = baseData();
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "merchants");
    expect(flow.links).toEqual([]);
    expect(income).toEqual([]);
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    expect(vm.left.cells).toEqual([]);
    expect(vm.left.remainingBySource).toEqual([]);
    const layout = layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
      width: 800,
      height: 400,
      leftHop: vm.left,
    });
    expect(layout.sources).toEqual([]);
    expect(layout.middles).toEqual([]);
    expect(layout.targets).toEqual([]);
    expect(layout.linksLeft).toEqual([]);
    expect(layout.linksRight).toEqual([]);
  });

  it("skips malformed funding references instead of crashing the layout", () => {
    const data = disjointErasData();
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "merchants");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    const layout = layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
      width: 800,
      height: 400,
      leftDetail: "cells",
      leftHop: {
        cells: [
          // Dangling source, dangling link, and non-positive values: all
          // skipped defensively (well-formed view models never emit them).
          { sourceIndex: 99, rightLinkIndex: 0, value: 100 },
          { sourceIndex: 0, rightLinkIndex: 99, value: 100 },
          { sourceIndex: 0, rightLinkIndex: 0, value: 0 },
          { sourceIndex: 0, rightLinkIndex: 0, value: -50 },
          // ...while the one well-formed entry still draws.
          { sourceIndex: 0, rightLinkIndex: 1, value: 300000 },
        ],
        remainingBySource: [],
        incomeTotal: vm.left.incomeTotal,
        spendingTotal: vm.left.spendingTotal,
      },
    });
    expect(layout.leftCells).toHaveLength(1);
    expect(layout.leftCells[0]!.value).toBeCloseTo(300000, 6);
    expect(layout.linksRight).toHaveLength(1);
  });

  it("draws whole explicit bands without subdivision in bands mode", () => {
    const data = disjointErasData();
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "merchants");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    const layout = layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
      width: 800,
      height: 400,
      leftHop: vm.left,
    });
    expect(layout.leftCells).toEqual([]);
    expect(layout.linksLeft).toHaveLength(2);
    const total = layout.linksLeft.reduce((sum, l) => sum + l.value, 0);
    expect(total).toBeCloseTo(800000, 6);
  });

  it("feeds the surplus plug only from the incomes still holding money", () => {
    const data = disjointErasData();
    data.transactions.push(txn("2021-02-05", "Windfall", 100000, null));
    const flow = computeSpendingGroupFlow(data, START, "2021-12", "merchants");
    const income = computeIncomeBreakdown(data, START, "2021-12");
    const series = computeMonthlySankeySeries(data, START, "2021-12", "merchants");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    const layout = layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
      width: 800,
      height: 400,
      leftDetail: "cells",
      leftHop: vm.left,
    });
    expect(layout.remainingTargetIndex).toBe(2);
    const plug = layout.linksLeft.filter((l) => l.targetName === "Remaining");
    expect(plug).toHaveLength(1);
    expect(plug[0]!.sourceName).toBe("Windfall");
    expect(plug[0]!.value).toBeCloseTo(100000, 6);
  });

  it("skips misaligned series rows instead of crashing the view model", () => {
    // Hand-built inputs a caller could misalign: a phantom source column,
    // a phantom cell column, and a link pointing outside both columns.
    const flow = {
      groups: [{ name: "Needs", value: 800000 }],
      targets: [
        { name: "Corner Store", value: 500000 },
        { name: "Late Landlord", value: 300000 },
      ],
      links: [
        { groupIndex: 0, targetIndex: 0, value: 500000 },
        { groupIndex: 0, targetIndex: 1, value: 300000 },
      ],
    };
    const income = [
      { name: "Early Employer", value: 500000 },
      { name: "New Payroll", value: 300000 },
    ];
    const series: MonthlySankeySeries = {
      months: ["2015-06", "2020-04"],
      incomeNames: ["Early Employer", "New Payroll"],
      groupNames: ["Needs"],
      targetNames: ["Corner Store", "Late Landlord"],
      incomeByMonth: [
        [500000, 0, 12345],
        [0, 300000, 0],
      ],
      cellByMonth: [
        [500000, 0, 999],
        [0, 300000, 0],
      ],
    };
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    // Phantom columns vanish; the aligned funding is untouched.
    expect(fundingOf(vm, "Early Employer", "Late Landlord")).toBe(0);
    expect(fundingOf(vm, "Early Employer", "Corner Store")).toBeCloseTo(500000, 6);
    expect(fundingOf(vm, "New Payroll", "Late Landlord")).toBeCloseTo(300000, 6);

    const dangling = computeSankeyViewModel(
      {
        groups: [{ name: "Needs", value: 100 }],
        targets: [{ name: "X", value: 100 }],
        links: [{ groupIndex: 5, targetIndex: 0, value: 100 }],
      },
      [{ name: "Pay", value: 100 }],
      {
        months: ["2020-01"],
        incomeNames: ["Pay"],
        groupNames: ["Needs"],
        targetNames: ["X"],
        incomeByMonth: [[100]],
        cellByMonth: [[100]],
      },
      { thresholdCents: 0 }
    );
    expect(dangling.links).toEqual([]);
    expect(dangling.left.cells).toEqual([]);
    expect(dangling.left.remainingBySource).toEqual([100]);
  });
});

describe("layoutGroupedIncomeSankey with explicit funding", () => {
  function timeAwareLayout() {
    const data = disjointErasData();
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series = computeMonthlySankeySeries(data, START, END, "merchants");
    const vm = computeSankeyViewModel(flow, income, series, { thresholdCents: 0 });
    const layout = layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
      width: 800,
      height: 400,
      padLeft: SANKEY_SOURCE_GUTTER,
      padRight: 190,
      padTop: SANKEY_PAD_TOP,
      padBottom: SANKEY_PAD_BOTTOM,
      nodeGap: SANKEY_NODE_GAP,
      leftDetail: "cells",
      leftHop: vm.left,
    });
    return { vm, layout };
  }

  it("draws one band per funding pair with the funded value, no taper on sub-ribbons", () => {
    const { layout } = timeAwareLayout();
    // Two funding pairs, no plug (income equals spending).
    expect(layout.remainingTargetIndex).toBeNull();
    expect(layout.linksLeft).toHaveLength(2);
    expect(layout.leftCells).toHaveLength(2);
    for (const sub of layout.leftCells) {
      expect(sub.sy1 - sub.sy0).toBeCloseTo(sub.ty1 - sub.ty0, 6);
      expect(sub.sy1 - sub.sy0).toBeGreaterThan(0);
    }
  });

  it("tiles each source band edge to edge with its sub-ribbons", () => {
    const { layout } = timeAwareLayout();
    for (const band of layout.linksLeft) {
      const subs = layout.leftCells
        .filter((c) => c.sourceIndex === band.sourceIndex && c.middleIndex === band.targetIndex)
        .sort((a, b) => a.sy0 - b.sy0);
      expect(subs.length).toBeGreaterThan(0);
      expect(subs[0]!.sy0).toBeCloseTo(band.sy0, 6);
      expect(subs[subs.length - 1]!.sy1).toBeCloseTo(band.sy1, 6);
      for (let k = 1; k < subs.length; k++) {
        expect(subs[k]!.sy0).toBeCloseTo(subs[k - 1]!.sy1, 6);
      }
    }
  });

  it("meets every income-bar gradient segment with its sub-ribbon exactly", () => {
    const { layout } = timeAwareLayout();
    for (let i = 0; i < layout.sources.length; i++) {
      const bar = layout.sources[i]!;
      const stops = layout.sourceFills[i]!;
      const subs = layout.leftCells.filter((c) => c.sourceIndex === i);
      expect(stops).toHaveLength(subs.length * 2);
      subs.forEach((sub, k) => {
        expect(stops[2 * k]!.color).toBe(sub.fill);
        expect(bar.y + stops[2 * k]!.offset * bar.h).toBeCloseTo(sub.sy0, 6);
        expect(bar.y + stops[2 * k + 1]!.offset * bar.h).toBeCloseTo(sub.sy1, 6);
      });
    }
  });

  it("auto-fit still resolves a stop when the time-aware series is attached", () => {
    const data = disjointErasData();
    const flow = computeSpendingGroupFlow(data, START, END, "merchants");
    const income = computeIncomeBreakdown(data, START, END);
    const series: MonthlySankeySeries = computeMonthlySankeySeries(data, START, END, "merchants");
    const stops = [0, 10, 50, 100, 500, 1000, 5000];
    const best = sankeyAutoFitThreshold(
      flow.groups,
      flow.targets,
      flow.links,
      income,
      stops,
      400,
      series
    );
    expect(stops).toContain(best);
    expect(
      sankeyAutoFitThreshold(flow.groups, flow.targets, flow.links, income, stops, 400, series)
    ).toBe(best);
  });
});
