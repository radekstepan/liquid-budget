import { describe, expect, it } from "vitest";
import { classifyBoundaryTransfer, TransactionError } from "../src/transfers.js";

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
});
