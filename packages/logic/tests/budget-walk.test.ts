import { describe, expect, it } from "vitest";
import {
  applyRefundWaterfall,
  collectCCGroupIds,
  collectSplitParentIds,
  mapCCPayCategories,
} from "../src/budget-walk.js";

describe("budget-walk set collectors (P2 decompose)", () => {
  it("collects split-parent ids, skipping plain rows", () => {
    expect(
      collectSplitParentIds([
        { parentId: null },
        { parentId: 7 },
        { parentId: 7 },
        {},
        { parentId: 9 },
      ])
    ).toEqual(new Set([7, 9]));
  });

  it("collects CC-payment group ids", () => {
    expect(
      collectCCGroupIds([
        { id: 1, isCreditCardPayments: false },
        { id: 2, isCreditCardPayments: true },
      ])
    ).toEqual(new Set([2]));
  });

  it("maps first linked CC-payment category per account", () => {
    const ccGroupIds = new Set([20]);
    const categories = [
      { groupId: 20, linkedAccountId: 5, id: 101 },
      { groupId: 20, linkedAccountId: 5, id: 102 },
      { groupId: 11, linkedAccountId: 6, id: 103 },
      { groupId: 20, linkedAccountId: null, id: 104 },
    ] as never;
    expect(mapCCPayCategories(categories, ccGroupIds)).toEqual(new Map([[5, 101]]));
  });
});

describe("applyRefundWaterfall (P2 decompose)", () => {
  it("pays prior debt, then current funded buffer, then parks card credit", () => {
    const accounts = {
      priorDebtMap: new Map([[5, 400]]),
      catDebtMap: new Map([[5, 400]]),
      catFundedCCByAccount: new Map([[5, 200]]),
      monthFundedCCByAccount: new Map([[5, 1000]]),
      availableCCBufferByAccount: new Map([[5, 100]]),
      cardCreditByAccount: new Map<number, number>(),
    };
    const out = applyRefundWaterfall({
      accountId: 5,
      refund: 1000,
      carriesOver: false,
      prev: -50,
      runningCashPool: 0,
      catFundedCC: 500,
      accounts,
    });

    // 400 prior debt + 200 current funded + 100 prior buffer = 700 absorbed,
    // 300 parks as card credit; the pool regrows by the 300 funded reversal.
    expect(out).toEqual({ runningCashPool: 300, catFundedCC: 300, priorUnfundedPaydown: 400 });
    expect(accounts.priorDebtMap.get(5)).toBe(0);
    expect(accounts.catDebtMap.get(5)).toBe(0);
    expect(accounts.catFundedCCByAccount.get(5)).toBe(0);
    expect(accounts.monthFundedCCByAccount.get(5)).toBe(700);
    expect(accounts.availableCCBufferByAccount.get(5)).toBe(0);
    expect(accounts.cardCreditByAccount.get(5)).toBe(300);
  });

  it("skips the prior-debt paydown record when the category carries over red", () => {
    const accounts = {
      priorDebtMap: new Map([[5, 400]]),
      catDebtMap: new Map([[5, 400]]),
      catFundedCCByAccount: new Map<number, number>(),
      monthFundedCCByAccount: new Map<number, number>(),
      availableCCBufferByAccount: new Map<number, number>(),
      cardCreditByAccount: new Map<number, number>(),
    };
    const out = applyRefundWaterfall({
      accountId: 5,
      refund: 100,
      carriesOver: true,
      prev: -50,
      runningCashPool: 0,
      catFundedCC: 0,
      accounts,
    });
    expect(out.priorUnfundedPaydown).toBe(0);
    expect(accounts.priorDebtMap.get(5)).toBe(300);
  });
});
