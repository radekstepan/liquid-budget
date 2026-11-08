/**
 * payload-builders-gaps.test.ts
 *
 * Focused coverage for payload-builder branches not exercised by the main
 * suite: integer-cents amounts, cleared/status mapping, duplicate flags,
 * edit-transfer payee handling, boundary-transfer inflow, and split
 * sub-row transfer legs (transaction + recurring).
 */
import { describe, expect, it } from "vitest";
import {
  toRecurringPayload,
  toTransactionPayload,
  type PayloadAccountContext,
} from "../src/index.js";

const accounts: PayloadAccountContext[] = [
  { id: 1, name: "Checking", onBudget: true, kind: "liquid" },
  { id: 2, name: "Savings", onBudget: true, kind: "liquid" },
  { id: 3, name: "Credit Card", onBudget: true, kind: "credit" },
  { id: 4, name: "Brokerage", onBudget: false, kind: "offbudget" },
];

describe("toTransactionPayload gaps", () => {
  it("treats integer number amounts as cents directly", () => {
    const payload = toTransactionPayload(
      {
        mode: "single",
        accountId: 1,
        date: "2026-06-15",
        payee: "Store",
        amount: -4550,
        categoryId: 10,
      },
      { accounts }
    );
    expect(payload).not.toBeNull();
    expect(payload?.mode).toBe("single");
    if (payload?.mode === "single") expect(payload.amount).toBe(-4550);
  });

  it("maps cleared through the initial reconciled status", () => {
    const reconciled = toTransactionPayload(
      {
        mode: "single",
        accountId: 1,
        date: "2026-06-15",
        payee: "Store",
        amount: "10.00",
        categoryId: 10,
        cleared: true,
      },
      { accounts, initial: { status: "r" } }
    );
    expect(reconciled?.mode).toBe("single");
    if (reconciled?.mode === "single") expect(reconciled.status).toBe("r");

    const uncleared = toTransactionPayload(
      {
        mode: "single",
        accountId: 1,
        date: "2026-06-15",
        payee: "Store",
        amount: "10.00",
        categoryId: 10,
        cleared: false,
      },
      { accounts }
    );
    expect(uncleared?.mode).toBe("single");
    if (uncleared?.mode === "single") expect(uncleared.status).toBe("u");
  });

  it("drops the duplicate marker flag from the saved payload", () => {
    const payload = toTransactionPayload(
      {
        mode: "single",
        accountId: 1,
        date: "2026-06-15",
        payee: "Store",
        amount: "10.00",
        categoryId: 10,
        flagColor: "duplicate",
      },
      { accounts }
    );
    expect(payload?.mode).toBe("single");
    if (payload?.mode === "single") expect(payload.flagColor).toBeUndefined();
  });

  it("forces the standard payee when converting a single into a transfer", () => {
    const payload = toTransactionPayload(
      {
        mode: "transfer",
        accountId: 1,
        transferAccountId: 2,
        date: "2026-06-15",
        payee: "Custom note",
        amount: "-200.00",
      },
      { accounts, initial: { id: 7 } }
    );
    expect(payload?.mode).toBe("transfer");
    if (payload?.mode === "transfer") expect(payload.payee).toBe("Transfer : Savings");
  });

  it("refreshes a standard transfer payee when the destination changes, keeps custom ones", () => {
    const refreshed = toTransactionPayload(
      {
        mode: "transfer",
        accountId: 1,
        transferAccountId: 3,
        date: "2026-06-15",
        payee: "Transfer : Savings",
        amount: "-200.00",
      },
      { accounts, initial: { id: 7, transferAccountId: 2 } }
    );
    expect(refreshed?.mode).toBe("transfer");
    if (refreshed?.mode === "transfer") expect(refreshed.payee).toBe("Transfer : Credit Card");

    const blank = toTransactionPayload(
      {
        mode: "transfer",
        accountId: 1,
        transferAccountId: 3,
        date: "2026-06-15",
        payee: "",
        amount: "-200.00",
      },
      { accounts, initial: { id: 7, transferAccountId: 2 } }
    );
    expect(blank?.mode).toBe("transfer");
    if (blank?.mode === "transfer") expect(blank.payee).toBe("Transfer : Credit Card");

    const custom = toTransactionPayload(
      {
        mode: "transfer",
        accountId: 1,
        transferAccountId: 3,
        date: "2026-06-15",
        payee: "Card payoff",
        amount: "-200.00",
      },
      { accounts, initial: { id: 7, transferAccountId: 2 } }
    );
    expect(custom?.mode).toBe("transfer");
    if (custom?.mode === "transfer") expect(custom.payee).toBe("Card payoff");
  });

  it("handles off-budget to on-budget boundary inflow picks", () => {
    const base = {
      mode: "transfer" as const,
      accountId: 4,
      transferAccountId: 1,
      date: "2026-06-15",
      amount: "-100.00",
    };
    const income = toTransactionPayload({ ...base, categoryId: "__income__" as const }, { accounts });
    expect(income?.mode).toBe("transfer");
    if (income?.mode === "transfer") {
      expect(income.categoryId).toBeNull();
      expect(income.incomeMonth).toBeNull();
    }

    const legacy = toTransactionPayload({ ...base, categoryId: null }, { accounts });
    expect(legacy?.mode).toBe("transfer");
    if (legacy?.mode === "transfer") expect(legacy.categoryId).toBeNull();

    const categorized = toTransactionPayload({ ...base, categoryId: 10 }, { accounts });
    expect(categorized?.mode).toBe("transfer");
    if (categorized?.mode === "transfer") expect(categorized.categoryId).toBe(10);

    const deferredDefault = toTransactionPayload(
      { ...base, categoryId: "__deferred__" as const },
      { accounts }
    );
    expect(deferredDefault?.mode).toBe("transfer");
    if (deferredDefault?.mode === "transfer") {
      expect(deferredDefault.categoryId).toBeNull();
      expect(deferredDefault.incomeMonth).toBe("2026-07");
    }

    const deferredExplicit = toTransactionPayload(
      { ...base, categoryId: "__deferred__" as const, incomeMonth: "2026-09" },
      { accounts }
    );
    if (deferredExplicit?.mode === "transfer") {
      expect(deferredExplicit.incomeMonth).toBe("2026-09");
    }

    expect(toTransactionPayload({ ...base, categoryId: "" }, { accounts })).toBeNull();
  });

  it("clears the category on non-boundary split sub-row transfers", () => {
    const payload = toTransactionPayload(
      {
        mode: "split",
        accountId: 1,
        date: "2026-06-15",
        payee: "Split Store",
        amount: -10000,
        subRows: [
          { transferAccountId: 2, amount: -6000 },
          { categoryId: 10, amount: -4000 },
        ],
      },
      { accounts }
    );
    expect(payload?.mode).toBe("split");
    if (payload?.mode === "split") {
      expect(payload.amount).toBe(-10000);
      expect(payload.subTransactions[0]).toMatchObject({
        categoryId: null,
        transferAccountId: 2,
        amount: -6000,
      });
    }
  });

  it("requires a category on boundary-outflow split sub-row transfers", () => {
    const base = {
      mode: "split" as const,
      accountId: 1,
      date: "2026-06-15",
      payee: "Split Store",
      amount: "-100.00",
    };
    expect(
      toTransactionPayload(
        {
          ...base,
          subRows: [
            { transferAccountId: 4, amount: "-60.00" },
            { categoryId: 10, amount: "-40.00" },
          ],
        },
        { accounts }
      )
    ).toBeNull();

    const ok = toTransactionPayload(
      {
        ...base,
        subRows: [
          { transferAccountId: 4, categoryId: 10, amount: "-60.00" },
          { categoryId: 10, amount: "-40.00" },
        ],
      },
      { accounts }
    );
    expect(ok?.mode).toBe("split");
    if (ok?.mode === "split") {
      expect(ok.subTransactions[0]).toMatchObject({ categoryId: 10, transferAccountId: 4 });
    }
  });

  it("clears categories on off-budget split sub-rows", () => {
    const payload = toTransactionPayload(
      {
        mode: "split",
        accountId: 4,
        date: "2026-06-15",
        payee: "Brokerage Split",
        amount: "-100.00",
        subRows: [
          { categoryId: 10, amount: "-60.00" },
          { categoryId: 11, amount: "-40.00" },
        ],
      },
      { accounts }
    );
    expect(payload?.mode).toBe("split");
    if (payload?.mode === "split") {
      expect(payload.subTransactions.map((s) => s.categoryId)).toEqual([null, null]);
    }
  });
});

describe("toRecurringPayload gaps", () => {
  const singleBase = {
    mode: "single" as const,
    accountId: 1,
    payee: "Netflix",
    frequency: "monthly",
    nextDate: "2026-07-01",
  };

  it("treats integer number amounts as cents directly", () => {
    const payload = toRecurringPayload(
      { ...singleBase, amount: -1599, categoryId: 10 },
      { accounts }
    );
    expect(payload?.mode).toBe("single");
    if (payload?.mode === "single") expect(payload.amount).toBe(-1599);
  });

  it("clears the category for off-budget or blank single picks", () => {
    const offBudget = toRecurringPayload(
      { ...singleBase, accountId: 4, amount: "100.00", categoryId: 10 },
      { accounts }
    );
    expect(offBudget?.mode).toBe("single");
    if (offBudget?.mode === "single") expect(offBudget.categoryId).toBeNull();

    const blank = toRecurringPayload(
      { ...singleBase, amount: "100.00", categoryId: "" },
      { accounts }
    );
    expect(blank?.mode).toBe("single");
    if (blank?.mode === "single") expect(blank.categoryId).toBeNull();
  });

  it("rejects recurring transfers with a missing or same-account destination", () => {
    const base = {
      mode: "transfer" as const,
      accountId: 1,
      amount: "-500.00",
      frequency: "monthly",
      nextDate: "2026-07-01",
    };
    expect(toRecurringPayload({ ...base, transferAccountId: 1 }, { accounts })).toBeNull();
    expect(toRecurringPayload({ ...base, transferAccountId: null }, { accounts })).toBeNull();
    expect(toRecurringPayload({ ...base }, { accounts })).toBeNull();
  });

  it("handles boundary recurring transfers in both directions", () => {
    // Outflow: on-budget -> off-budget requires a category.
    const outflowBase = {
      mode: "transfer" as const,
      accountId: 1,
      transferAccountId: 4,
      amount: "-500.00",
      frequency: "monthly",
      nextDate: "2026-07-01",
    };
    expect(toRecurringPayload({ ...outflowBase, categoryId: "" }, { accounts })).toBeNull();
    expect(toRecurringPayload({ ...outflowBase, categoryId: null }, { accounts })).toBeNull();
    const outflow = toRecurringPayload({ ...outflowBase, categoryId: 11 }, { accounts });
    expect(outflow?.mode).toBe("transfer");
    if (outflow?.mode === "transfer") expect(outflow.categoryId).toBe(11);

    // Inflow: off-budget -> on-budget keeps income (null) unless categorized.
    const inflowBase = {
      mode: "transfer" as const,
      accountId: 4,
      transferAccountId: 1,
      amount: "-100.00",
      frequency: "monthly",
      nextDate: "2026-07-01",
    };
    const blank = toRecurringPayload({ ...inflowBase, categoryId: "" }, { accounts });
    if (blank?.mode === "transfer") expect(blank.categoryId).toBeNull();
    const legacy = toRecurringPayload({ ...inflowBase, categoryId: null }, { accounts });
    if (legacy?.mode === "transfer") expect(legacy.categoryId).toBeNull();
    const categorized = toRecurringPayload({ ...inflowBase, categoryId: 10 }, { accounts });
    if (categorized?.mode === "transfer") expect(categorized.categoryId).toBe(10);
  });

  it("handles recurring split sub-row transfer legs", () => {
    const base = {
      mode: "split" as const,
      accountId: 1,
      payee: "Split",
      amount: "-100.00",
      frequency: "monthly",
      nextDate: "2026-07-01",
    };
    // Non-boundary leg drops any category.
    const internal = toRecurringPayload(
      {
        ...base,
        subRows: [
          { transferAccountId: 2, amount: "-60.00" },
          { categoryId: 10, amount: "-40.00" },
        ],
      },
      { accounts }
    );
    expect(internal?.mode).toBe("split");
    if (internal?.mode === "split") {
      expect(internal.subTransactions[0]).toMatchObject({ categoryId: null, transferAccountId: 2 });
    }

    // Boundary outflow leg without a category blocks save; with one it keeps it.
    expect(
      toRecurringPayload(
        {
          ...base,
          subRows: [
            { transferAccountId: 4, amount: "-60.00" },
            { categoryId: 10, amount: "-40.00" },
          ],
        },
        { accounts }
      )
    ).toBeNull();
    const boundary = toRecurringPayload(
      {
        ...base,
        subRows: [
          { transferAccountId: 4, categoryId: 10, amount: "-60.00" },
          { categoryId: 10, amount: "-40.00" },
        ],
      },
      { accounts }
    );
    if (boundary?.mode === "split") {
      expect(boundary.subTransactions[0]).toMatchObject({ categoryId: 10, transferAccountId: 4 });
    }

    // Off-budget plain legs drop categories.
    const offBudget = toRecurringPayload(
      {
        ...base,
        accountId: 4,
        subRows: [
          { categoryId: 10, amount: "-60.00" },
          { categoryId: 11, amount: "-40.00" },
        ],
      },
      { accounts }
    );
    if (offBudget?.mode === "split") {
      expect(offBudget.subTransactions.map((s) => s.categoryId)).toEqual([null, null]);
    }
  });

  it("rejects recurring splits whose legs do not sum to the total", () => {
    expect(
      toRecurringPayload(
        {
          mode: "split",
          accountId: 1,
          payee: "Split",
          amount: "-100.00",
          frequency: "monthly",
          nextDate: "2026-07-01",
          subRows: [
            { categoryId: 10, amount: "-60.00" },
            { categoryId: 11, amount: "-30.00" },
          ],
        },
        { accounts }
      )
    ).toBeNull();
  });
});
