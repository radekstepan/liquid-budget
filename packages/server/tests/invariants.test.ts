import { describe, expect, it } from "vitest";
import { assertEntityInvariants, TransactionError } from "../src/index.js";

describe("assertEntityInvariants", () => {
  it("passes for valid standard non-transfer non-split transactions", () => {
    expect(() =>
      assertEntityInvariants({
        accountId: 1,
        transferAccountId: null,
        subTransactions: null,
      })
    ).not.toThrow();

    expect(() =>
      assertEntityInvariants({
        accountId: 1,
      })
    ).not.toThrow();
  });

  it("passes for valid transfers between different accounts", () => {
    expect(() =>
      assertEntityInvariants({
        accountId: 1,
        transferAccountId: 2,
        subTransactions: null,
      })
    ).not.toThrow();
  });

  it("passes for valid split transactions with subtransactions transferring to different accounts", () => {
    expect(() =>
      assertEntityInvariants({
        accountId: 1,
        transferAccountId: null,
        subTransactions: [
          { amount: -5000, categoryId: 10 },
          { amount: -2000, transferAccountId: 2 },
        ],
      })
    ).not.toThrow();
  });

  describe("Invariant 1: Split transaction cannot be a transfer", () => {
    it("throws 400 TransactionError when both transferAccountId and subTransactions are present", () => {
      expect(() =>
        assertEntityInvariants({
          accountId: 1,
          transferAccountId: 2,
          subTransactions: [{ amount: -1000, categoryId: 5 }],
        })
      ).toThrowError(
        expect.objectContaining({
          name: "TransactionError",
          message: "Split transaction cannot be a transfer",
          status: 400,
        })
      );
    });
  });

  describe("Invariant 2: Transfer destination cannot be the source account", () => {
    it("throws 422 TransactionError when transferAccountId equals accountId on root entity", () => {
      expect(() =>
        assertEntityInvariants({
          accountId: 1,
          transferAccountId: 1,
        })
      ).toThrowError(
        expect.objectContaining({
          name: "TransactionError",
          message: "Transfer destination cannot be the source account",
          status: 422,
        })
      );
    });

    it("throws 422 TransactionError when a nested subtransaction transfers to the parent source account", () => {
      expect(() =>
        assertEntityInvariants({
          accountId: 1,
          transferAccountId: null,
          subTransactions: [
            { amount: -3000, categoryId: 2 },
            { amount: -2000, transferAccountId: 1 },
          ],
        })
      ).toThrowError(
        expect.objectContaining({
          name: "TransactionError",
          message: "Transfer destination cannot be the source account",
          status: 422,
        })
      );
    });
  });
});
