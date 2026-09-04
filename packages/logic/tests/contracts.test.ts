import { describe, expect, expectTypeOf, it } from "vitest";
import {
  RecurringCreateSchema,
  RecurringPatchSchema,
  TransactionBulkUpdateSchema,
  TransactionCreateSchema,
  TransactionPatchSchema,
  makeSeedBudgetData,
  parseBudgetDataResponse,
  toRecurringPayload,
  toTransactionPayload,
  type BulkUpdateTransactionPatch,
  type PayloadAccountContext,
} from "../src/index.js";

const accounts: PayloadAccountContext[] = [
  { id: 1, name: "Checking", onBudget: true, kind: "liquid" },
  { id: 2, name: "Savings", onBudget: true, kind: "liquid" },
  { id: 4, name: "Brokerage", onBudget: false, kind: "offbudget" },
];

/** Mirror the wire: JSON drops undefined, strict schemas reject unknown keys. */
function wire<T>(payload: T): unknown {
  return JSON.parse(JSON.stringify(payload));
}

describe("request contracts: builder output satisfies API schemas", () => {
  it("single transaction payload validates as create input", () => {
    const payload = toTransactionPayload(
      {
        mode: "single",
        accountId: 1,
        date: "2026-06-15",
        payee: "Grocery Store",
        amount: "-45.50",
        categoryId: 10,
        cleared: true,
      },
      { accounts }
    );
    expect(payload).not.toBeNull();
    const result = TransactionCreateSchema.safeParse(wire(payload));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mode).toBe("single");
  });

  it("transfer transaction payload validates as create input", () => {
    const payload = toTransactionPayload(
      {
        mode: "transfer",
        accountId: 1,
        transferAccountId: 2,
        date: "2026-06-15",
        payee: "",
        amount: "100.00",
      },
      { accounts }
    );
    expect(payload).not.toBeNull();
    expect(TransactionCreateSchema.safeParse(wire(payload)).success).toBe(true);
  });

  it("split transaction payload validates as create input", () => {
    const payload = toTransactionPayload(
      {
        mode: "split",
        accountId: 1,
        date: "2026-06-15",
        payee: " Big Shop ",
        amount: "50.00",
        subRows: [
          { categoryId: 10, amount: "30.00" },
          { categoryId: 11, amount: "20.00" },
        ],
      },
      { accounts }
    );
    expect(payload).not.toBeNull();
    expect(TransactionCreateSchema.safeParse(wire(payload)).success).toBe(true);
  });

  it("transaction payload with id validates as patch input", () => {
    const payload = toTransactionPayload(
      {
        mode: "single",
        id: 7,
        accountId: 1,
        date: "2026-06-15",
        payee: "Grocery Store",
        amount: "-45.50",
        categoryId: 10,
      },
      { accounts, initial: { id: 7 } }
    );
    expect(payload).not.toBeNull();
    expect(TransactionPatchSchema.safeParse(wire(payload)).success).toBe(true);
  });

  it("recurring payloads validate as create/patch inputs", () => {
    const base = {
      accountId: 1,
      payee: "Gym",
      amount: "-30.00",
      frequency: "monthly",
      nextDate: "2026-07-10",
      categoryId: 10,
    } as const;
    const single = toRecurringPayload({ ...base, mode: "single" }, { accounts });
    expect(RecurringCreateSchema.safeParse(wire(single)).success).toBe(true);

    const transfer = toRecurringPayload(
      { ...base, mode: "transfer", transferAccountId: 2, categoryId: "" },
      { accounts }
    );
    expect(RecurringCreateSchema.safeParse(wire(transfer)).success).toBe(true);

    const split = toRecurringPayload(
      {
        ...base,
        mode: "split",
        amount: "50.00",
        subRows: [
          { categoryId: 10, amount: "30.00" },
          { categoryId: 11, amount: "20.00" },
        ],
      },
      { accounts }
    );
    expect(RecurringCreateSchema.safeParse(wire(split)).success).toBe(true);

    const patch = toRecurringPayload({ ...base, mode: "single", id: 3 }, { accounts });
    expect(RecurringPatchSchema.safeParse(wire(patch)).success).toBe(true);
  });
});

describe("bulk-update contract: reconciled status is rejected", () => {
  it("type excludes 'r' so the reconcile flow stays the only writer", () => {
    expectTypeOf<BulkUpdateTransactionPatch["status"]>().toEqualTypeOf<"u" | "c" | undefined>();
    expectTypeOf<BulkUpdateTransactionPatch["transferStatus"]>().toEqualTypeOf<
      "u" | "c" | undefined
    >();
  });

  it("schema rejects status 'r' (server throws the same way)", () => {
    expect(
      TransactionBulkUpdateSchema.safeParse({ ids: [1], patch: { status: "r" } }).success
    ).toBe(false);
    expect(
      TransactionBulkUpdateSchema.safeParse({ ids: [1], patch: { transferStatus: "r" } }).success
    ).toBe(false);
    expect(
      TransactionBulkUpdateSchema.safeParse({ ids: [1], patch: { status: "c" } }).success
    ).toBe(true);
  });
});

describe("response contract: GET /api/budget", () => {
  it("accepts the seed budget unchanged (no field stripping)", () => {
    const seed = makeSeedBudgetData();
    const parsed = parseBudgetDataResponse(seed);
    expect(parsed).toEqual(seed);
  });

  it("rejects numeric money (wire convention is base-unit strings)", () => {
    const seed = structuredClone(makeSeedBudgetData());
    (seed.accounts[0] as { balance: unknown }).balance = 123;
    expect(() => parseBudgetDataResponse(seed)).toThrow(/Invalid budget response/);
  });

  it("rejects garbage payloads with a descriptive error", () => {
    expect(() => parseBudgetDataResponse(null)).toThrow(/Invalid budget response/);
    expect(() => parseBudgetDataResponse({ accounts: [] })).toThrow(/Invalid budget response/);
  });
});
