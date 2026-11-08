/**
 * payee-autofill.test.ts
 *
 * Covers `suggestAutofillForPayee` fallback paths: entity defaults seeding
 * the proposal when history is empty, null results, id tiebreaks, and the
 * excludeId filter.
 */
import { describe, expect, it } from "vitest";
import {
  suggestAutofillForPayee,
  type PayeeAutofillHistoryRow,
} from "../src/payee-autofill.js";

function row(over: Partial<PayeeAutofillHistoryRow> & { id: number }): PayeeAutofillHistoryRow {
  return {
    payee: "Whole Foods",
    amount: "-5000",
    memo: "",
    categoryId: null,
    date: "2026-06-01",
    ...over,
  };
}

describe("suggestAutofillForPayee", () => {
  it("returns null for a blank payee name", () => {
    expect(suggestAutofillForPayee([row({ id: 1 })], "   ")).toBeNull();
  });

  it("returns null when there is no history and no entity default", () => {
    expect(suggestAutofillForPayee([], "Whole Foods")).toBeNull();
    expect(suggestAutofillForPayee([row({ id: 1, payee: "Other" })], "Whole Foods")).toBeNull();
  });

  it("seeds the proposal from entity defaults when history is empty", () => {
    expect(
      suggestAutofillForPayee([], "Whole Foods", {
        defaultCategoryId: 10,
        defaultMemo: "weekly shop",
        defaultAmount: "-5000",
      })
    ).toEqual({ categoryId: 10, amount: "-5000", memo: "weekly shop" });
  });

  it("rounds numeric entity default amounts to cents strings", () => {
    expect(
      suggestAutofillForPayee([], "Whole Foods", { defaultAmount: -5000.6 })
    ).toEqual({ categoryId: null, amount: "-5001", memo: "" });
  });

  it("falls back to entity defaults when excludeId removes all history", () => {
    const history = [row({ id: 1, amount: "-5000", memo: "hist", categoryId: 7 })];
    expect(
      suggestAutofillForPayee(history, "Whole Foods", {
        excludeId: 1,
        defaultCategoryId: 10,
        defaultMemo: "seed",
      })
    ).toEqual({ categoryId: 10, amount: null, memo: "seed" });
    expect(suggestAutofillForPayee(history, "Whole Foods", { excludeId: 1 })).toBeNull();
  });

  it("breaks same-date ties by higher id", () => {
    const history = [
      row({ id: 1, amount: "-1000", memo: "older", categoryId: 7 }),
      row({ id: 2, amount: "-2000", memo: "newer", categoryId: null }),
    ];
    // Most recent row proposes amount+memo; category falls back to the most
    // recent non-null history category.
    expect(suggestAutofillForPayee(history, "Whole Foods")).toEqual({
      categoryId: 7,
      amount: "-2000",
      memo: "newer",
    });
  });

  it("prefers the entity default category over history", () => {
    const history = [row({ id: 1, amount: "-5000", memo: "hist", categoryId: 7 })];
    expect(
      suggestAutofillForPayee(history, "Whole Foods", { defaultCategoryId: 10 })
    ).toEqual({ categoryId: 10, amount: "-5000", memo: "hist" });
  });
});
