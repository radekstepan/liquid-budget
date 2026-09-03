import { describe, expect, it } from "vitest";
import {
  canBuildRecurringPayload,
  canBuildTransactionPayload,
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

describe("toTransactionPayload", () => {
  describe("single mode", () => {
    it("builds a valid single transaction payload with integer amount in cents", () => {
      const payload = toTransactionPayload(
        {
          mode: "single",
          accountId: 1,
          date: "2026-06-15",
          payee: "Grocery Store",
          amount: "-45.50",
          categoryId: 10,
          memo: "Groceries",
          cleared: true,
          flagColor: "blue",
        },
        { accounts }
      );

      expect(payload).toEqual({
        mode: "single",
        id: undefined,
        accountId: 1,
        categoryId: 10,
        date: "2026-06-15",
        payee: "Grocery Store",
        memo: "Groceries",
        amount: -4550,
        status: "c",
        flagColor: "blue",
        incomeMonth: null,
        transferAccountId: null,
        subTransactions: undefined,
      });
    });

    it("clears category on off-budget account in single mode", () => {
      const payload = toTransactionPayload(
        {
          mode: "single",
          accountId: 4, // off-budget
          date: "2026-06-15",
          payee: "Brokerage Contribution",
          amount: "100.00",
          categoryId: 10,
        },
        { accounts }
      );

      expect(payload).not.toBeNull();
      expect(payload?.mode).toBe("single");
      if (payload?.mode === "single") {
        expect(payload.categoryId).toBeNull();
        expect(payload.incomeMonth).toBeNull();
        expect(payload.transferAccountId).toBeNull();
      }
    });

    it("handles deferred income category in single mode", () => {
      const payload = toTransactionPayload(
        {
          mode: "single",
          accountId: 1,
          date: "2026-06-15",
          payee: "Paycheck",
          amount: "2500.00",
          categoryId: "__deferred__",
          incomeMonth: "2026-07",
        },
        { accounts }
      );

      expect(payload).not.toBeNull();
      expect(payload?.mode).toBe("single");
      if (payload?.mode === "single") {
        expect(payload.categoryId).toBeNull();
        expect(payload.incomeMonth).toBe("2026-07");
      }
    });

    it("rejects when payee is empty or whitespace", () => {
      const payload = toTransactionPayload(
        {
          mode: "single",
          accountId: 1,
          date: "2026-06-15",
          payee: "   ",
          amount: "-50.00",
        },
        { accounts }
      );

      expect(payload).toBeNull();
      expect(
        canBuildTransactionPayload(
          {
            mode: "single",
            accountId: 1,
            date: "2026-06-15",
            payee: "   ",
            amount: "-50.00",
          },
          { accounts }
        )
      ).toBe(false);
    });

    it("does not leak subRows or transferAccountId if switching from other modes", () => {
      const payload = toTransactionPayload(
        {
          mode: "single",
          accountId: 1,
          date: "2026-06-15",
          payee: "Supermarket",
          amount: "-30.00",
          transferAccountId: 2, // residual from transfer tab
          subRows: [{ categoryId: 10, amount: "-30.00" }], // residual from split tab
        },
        { accounts }
      );

      expect(payload).toEqual({
        mode: "single",
        id: undefined,
        accountId: 1,
        categoryId: null,
        date: "2026-06-15",
        payee: "Supermarket",
        memo: "",
        amount: -3000,
        status: "c",
        flagColor: undefined,
        incomeMonth: null,
        transferAccountId: null,
        subTransactions: undefined,
      });
    });
  });

  describe("transfer mode", () => {
    it("builds an on-budget to on-budget transfer with null category and default payee", () => {
      const payload = toTransactionPayload(
        {
          mode: "transfer",
          accountId: 1,
          transferAccountId: 2,
          date: "2026-06-15",
          amount: "-200.00",
        },
        { accounts }
      );

      expect(payload).toEqual({
        mode: "transfer",
        id: undefined,
        accountId: 1,
        transferAccountId: 2,
        categoryId: null,
        date: "2026-06-15",
        payee: "Transfer : Savings",
        memo: "",
        amount: -20000,
        status: "c",
        flagColor: undefined,
        incomeMonth: null,
        subTransactions: undefined,
      });
    });

    it("requires a category for on-budget to off-budget boundary transfer outflow", () => {
      // Missing category
      const invalidPayload = toTransactionPayload(
        {
          mode: "transfer",
          accountId: 1,
          transferAccountId: 4, // off-budget
          date: "2026-06-15",
          amount: "-500.00",
          categoryId: "",
        },
        { accounts }
      );
      expect(invalidPayload).toBeNull();

      // With category
      const validPayload = toTransactionPayload(
        {
          mode: "transfer",
          accountId: 1,
          transferAccountId: 4,
          date: "2026-06-15",
          amount: "-500.00",
          categoryId: 11,
        },
        { accounts }
      );
      expect(validPayload).not.toBeNull();
      expect(validPayload?.mode).toBe("transfer");
      if (validPayload?.mode === "transfer") {
        expect(validPayload.categoryId).toBe(11);
      }
    });

    it("rejects transfer when destination account is the same as source account", () => {
      const payload = toTransactionPayload(
        {
          mode: "transfer",
          accountId: 1,
          transferAccountId: 1,
          date: "2026-06-15",
          amount: "-100.00",
        },
        { accounts }
      );
      expect(payload).toBeNull();
    });
  });

  describe("split mode", () => {
    it("builds a valid split transaction payload when sub-transactions balance", () => {
      const payload = toTransactionPayload(
        {
          mode: "split",
          accountId: 1,
          date: "2026-06-15",
          payee: "Department Store",
          amount: "-100.00",
          subRows: [
            { categoryId: 10, amount: "-60.00", memo: "Clothes" },
            { categoryId: 11, amount: "-40.00", memo: "Housewares" },
          ],
        },
        { accounts }
      );

      expect(payload).toEqual({
        mode: "split",
        id: undefined,
        accountId: 1,
        date: "2026-06-15",
        payee: "Department Store",
        memo: "",
        amount: -10000,
        status: "c",
        flagColor: undefined,
        categoryId: null,
        transferAccountId: null,
        incomeMonth: null,
        subTransactions: [
          { id: undefined, payee: undefined, categoryId: 10, transferAccountId: null, amount: -6000, memo: "Clothes" },
          { id: undefined, payee: undefined, categoryId: 11, transferAccountId: null, amount: -4000, memo: "Housewares" },
        ],
      });
    });

    it("rejects split when sub-transactions do not sum to total amount", () => {
      const payload = toTransactionPayload(
        {
          mode: "split",
          accountId: 1,
          date: "2026-06-15",
          payee: "Store",
          amount: "-100.00",
          subRows: [
            { categoryId: 10, amount: "-60.00" },
            { categoryId: 11, amount: "-30.00" },
          ],
        },
        { accounts }
      );
      expect(payload).toBeNull();
    });

    it("rejects split with fewer than 2 sub-transactions", () => {
      const payload = toTransactionPayload(
        {
          mode: "split",
          accountId: 1,
          date: "2026-06-15",
          payee: "Store",
          amount: "-100.00",
          subRows: [{ categoryId: 10, amount: "-100.00" }],
        },
        { accounts }
      );
      expect(payload).toBeNull();
    });
  });
});

describe("toRecurringPayload", () => {
  it("builds a valid single recurring payload", () => {
    const payload = toRecurringPayload(
      {
        mode: "single",
        accountId: 1,
        payee: "Netflix",
        amount: "-15.99",
        frequency: "monthly",
        nextDate: "2026-07-01",
        categoryId: 10,
        anchorDay: 1,
      },
      { accounts }
    );

    expect(payload).toEqual({
      mode: "single",
      id: undefined,
      accountId: 1,
      categoryId: 10,
      payee: "Netflix",
      memo: "",
      amount: -1599,
      frequency: "monthly",
      nextDate: "2026-07-01",
      anchorDay: 1,
      active: true,
      flagColor: null,
      transferAccountId: null,
      subTransactions: undefined,
    });
  });

  it("builds a valid transfer recurring payload", () => {
    const payload = toRecurringPayload(
      {
        mode: "transfer",
        accountId: 1,
        transferAccountId: 2,
        amount: "-500.00",
        frequency: "monthly",
        nextDate: "2026-07-01",
      },
      { accounts }
    );

    expect(payload).toEqual({
      mode: "transfer",
      id: undefined,
      accountId: 1,
      transferAccountId: 2,
      categoryId: null,
      payee: "Transfer : Savings",
      memo: "",
      amount: -50000,
      frequency: "monthly",
      nextDate: "2026-07-01",
      anchorDay: null,
      active: true,
      flagColor: null,
      subTransactions: undefined,
    });
  });

  it("builds a valid split recurring payload", () => {
    const payload = toRecurringPayload(
      {
        mode: "split",
        accountId: 1,
        payee: "Paycheck Split",
        amount: "3000.00",
        frequency: "monthly",
        nextDate: "2026-07-01",
        subRows: [
          { categoryId: 10, amount: "2000.00", memo: "Primary" },
          { categoryId: 11, amount: "1000.00", memo: "Secondary" },
        ],
      },
      { accounts }
    );

    expect(payload).toEqual({
      mode: "split",
      id: undefined,
      accountId: 1,
      categoryId: null,
      transferAccountId: null,
      payee: "Paycheck Split",
      memo: "",
      amount: 300000,
      frequency: "monthly",
      nextDate: "2026-07-01",
      anchorDay: null,
      active: true,
      flagColor: null,
      subTransactions: [
        { id: undefined, categoryId: 10, transferAccountId: null, amount: 200000, memo: "Primary" },
        { id: undefined, categoryId: 11, transferAccountId: null, amount: 100000, memo: "Secondary" },
      ],
    });
  });
});
