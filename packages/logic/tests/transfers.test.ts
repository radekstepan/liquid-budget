import { describe, expect, it } from "vitest";
import {
  classifyBoundaryTransfer,
  isCreditPayoffTransfer,
  TransactionError,
  transferNetOnBudgetDelta,
} from "../src/transfers.js";
import type { Account, Transaction } from "../src/types.js";

describe("classifyBoundaryTransfer", () => {
  it("classifies internal transfers between same budget boundary as non-boundary and non-income", () => {
    // Both on-budget
    const result1 = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: true,
      amount: -5000,
      categoryId: 123,
    });
    expect(result1).toEqual({
      isBoundaryCrossing: false,
      netOnBudgetDelta: 0,
      categoryId: null,
      isIncome: false,
      incomeMonth: null,
    });

    // Both off-budget
    const result2 = classifyBoundaryTransfer({
      srcOnBudget: false,
      destOnBudget: false,
      amount: 5000,
      categoryId: null,
    });
    expect(result2).toEqual({
      isBoundaryCrossing: false,
      netOnBudgetDelta: 0,
      categoryId: null,
      isIncome: false,
      incomeMonth: null,
    });
  });

  it("classifies boundary inflow without category as income to TBB", () => {
    // Off-budget to On-budget: src off-budget (amount: -5000) -> dest on-budget (+5000)
    // netOnBudgetDelta = (0) + (-(-5000)) = +5000 > 0
    const result1 = classifyBoundaryTransfer({
      srcOnBudget: false,
      destOnBudget: true,
      amount: -5000,
      categoryId: null,
      incomeMonth: "2026-08",
    });
    expect(result1).toEqual({
      isBoundaryCrossing: true,
      netOnBudgetDelta: 5000,
      categoryId: null,
      isIncome: true,
      incomeMonth: "2026-08",
    });

    // On-budget source with positive amount: src on-budget (amount: +5000) -> dest off-budget (-5000)
    // netOnBudgetDelta = 5000 + 0 = +5000 > 0
    const result2 = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: false,
      amount: 5000,
      categoryId: null,
    });
    expect(result2).toEqual({
      isBoundaryCrossing: true,
      netOnBudgetDelta: 5000,
      categoryId: null,
      isIncome: true,
      incomeMonth: null,
    });
  });

  it("classifies boundary inflow with category as categorized non-income", () => {
    const result = classifyBoundaryTransfer({
      srcOnBudget: false,
      destOnBudget: true,
      amount: -5000,
      categoryId: 42,
      incomeMonth: "2026-08",
    });
    expect(result).toEqual({
      isBoundaryCrossing: true,
      netOnBudgetDelta: 5000,
      categoryId: 42,
      isIncome: false,
      incomeMonth: null,
    });
  });

  it("classifies boundary outflow with category as categorized non-income", () => {
    // On-budget to off-budget outflow: src on-budget (amount: -5000) -> dest off-budget (+5000)
    // netOnBudgetDelta = -5000 + 0 = -5000 < 0
    const result = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: false,
      amount: -5000,
      categoryId: 42,
    });
    expect(result).toEqual({
      isBoundaryCrossing: true,
      netOnBudgetDelta: -5000,
      categoryId: 42,
      isIncome: false,
      incomeMonth: null,
    });
  });

  it("throws TransactionError (or custom error) on boundary outflow without category", () => {
    expect(() =>
      classifyBoundaryTransfer({
        srcOnBudget: true,
        destOnBudget: false,
        amount: -5000,
        categoryId: null,
      })
    ).toThrow(TransactionError);

    // Custom error factory
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "CustomError";
      }
    }

    expect(() =>
      classifyBoundaryTransfer({
        srcOnBudget: true,
        destOnBudget: false,
        amount: -5000,
        categoryId: null,
        errorFactory: (msg) => new CustomError(msg),
      })
    ).toThrow(CustomError);
  });

  it("returns classification without throwing when allowMissingOutflowCategory is true for boundary outflow", () => {
    const result = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: false,
      amount: -5000,
      categoryId: null,
      allowMissingOutflowCategory: true,
    });
    expect(result).toEqual({
      isBoundaryCrossing: true,
      netOnBudgetDelta: -5000,
      categoryId: null,
      isIncome: false,
      incomeMonth: null,
    });
  });
});

function transferRow(
  accountId: number,
  transferAccountId: number | null,
  amount: string
): Transaction {
  return {
    id: 1,
    accountId,
    categoryId: null,
    date: "2026-06-15",
    payee: "Transfer",
    memo: "",
    amount,
    status: "c",
    transferAccountId,
  };
}

const CHEQUING: Account = { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Budget", balance: "0", onBudget: true, sort: 0 };
const SAVINGS: Account = { id: 2, name: "Savings", kind: "liquid", groupLabel: "Budget", balance: "0", onBudget: true, sort: 1 };
const VISA: Account = { id: 3, name: "Visa", kind: "credit", groupLabel: "Credit", balance: "0", onBudget: true, sort: 2 };
const TRACKING_LOAN: Account = { id: 4, name: "Tracking Loan", kind: "credit", groupLabel: "Loans", balance: "0", onBudget: false, sort: 3 };
const TRADE: Account = { id: 5, name: "Wealthsimple Trade", kind: "offbudget", groupLabel: "Investments", balance: "0", onBudget: false, sort: 4 };
const ALL_ACCOUNTS = [CHEQUING, SAVINGS, VISA, TRACKING_LOAN, TRADE];

describe("transferNetOnBudgetDelta", () => {
  it("returns 0 for non-transfer rows", () => {
    expect(transferNetOnBudgetDelta(transferRow(1, null, "-5000"), ALL_ACCOUNTS)).toBe(0);
    expect(transferNetOnBudgetDelta(transferRow(1, null, "5000"), ALL_ACCOUNTS)).toBe(0);
  });

  it("returns 0 for internal (same-boundary) transfers", () => {
    expect(transferNetOnBudgetDelta(transferRow(1, 2, "-5000"), ALL_ACCOUNTS)).toBe(0);
    expect(transferNetOnBudgetDelta(transferRow(1, 3, "-5000"), ALL_ACCOUNTS)).toBe(0);
  });

  it("is negative for boundary outflows (contributions leaving the budget)", () => {
    expect(transferNetOnBudgetDelta(transferRow(1, 5, "-30000"), ALL_ACCOUNTS)).toBe(-30000);
  });

  it("is positive for boundary inflows (withdrawals) recorded on either leg", () => {
    // Recorded on the on-budget side (positive amount into chequing).
    expect(transferNetOnBudgetDelta(transferRow(1, 5, "100000"), ALL_ACCOUNTS)).toBe(100000);
    // Recorded on the off-budget side (negative amount out of the investment).
    expect(transferNetOnBudgetDelta(transferRow(5, 1, "-75000"), ALL_ACCOUNTS)).toBe(75000);
  });

  it("accepts a Map of accounts and defaults missing accounts to on-budget", () => {
    const map = new Map(ALL_ACCOUNTS.map((a) => [a.id, a]));
    expect(transferNetOnBudgetDelta(transferRow(1, 5, "-30000"), map)).toBe(-30000);
    // Unknown destination defaults to on-budget, so the move reads as internal.
    expect(transferNetOnBudgetDelta(transferRow(1, 999, "-30000"), ALL_ACCOUNTS)).toBe(0);
    // No accounts at all: everything reads as internal (delta 0).
    expect(transferNetOnBudgetDelta(transferRow(1, 5, "-30000"))).toBe(0);
  });
});

describe("isCreditPayoffTransfer", () => {
  it("flags internal transfers touching an on-budget credit account", () => {
    // Payoff from chequing (credit leg is the destination).
    expect(isCreditPayoffTransfer(transferRow(1, 3, "-20000"), ALL_ACCOUNTS)).toBe(true);
    // Cash advance out of the card (credit leg is the source): movement too.
    expect(isCreditPayoffTransfer(transferRow(3, 1, "-5000"), ALL_ACCOUNTS)).toBe(true);
  });

  it("rejects boundary-crossing transfers even with a credit leg", () => {
    // Paying a tracking/off-budget loan from the budget is a real outflow.
    expect(isCreditPayoffTransfer(transferRow(1, 4, "-20000"), ALL_ACCOUNTS)).toBe(false);
    // Drawing from an off-budget card into the budget is a boundary inflow.
    expect(isCreditPayoffTransfer(transferRow(4, 1, "-20000"), ALL_ACCOUNTS)).toBe(false);
  });

  it("rejects internal moves between off-budget accounts", () => {
    // The credit leg is off-budget, so budget reports are unaffected either way.
    expect(isCreditPayoffTransfer(transferRow(4, 5, "-1000"), ALL_ACCOUNTS)).toBe(false);
  });

  it("rejects non-credit internal transfers and regular rows", () => {
    expect(isCreditPayoffTransfer(transferRow(1, 2, "-5000"), ALL_ACCOUNTS)).toBe(false);
    expect(isCreditPayoffTransfer(transferRow(1, null, "-5000"), ALL_ACCOUNTS)).toBe(false);
  });

  it("accepts a Map of accounts and is conservative without account data", () => {
    const map = new Map(ALL_ACCOUNTS.map((a) => [a.id, a]));
    expect(isCreditPayoffTransfer(transferRow(1, 3, "-20000"), map)).toBe(true);
    expect(isCreditPayoffTransfer(transferRow(1, 3, "-20000"))).toBe(false);
    expect(isCreditPayoffTransfer(transferRow(1, 999, "-20000"), ALL_ACCOUNTS)).toBe(false);
  });
});

