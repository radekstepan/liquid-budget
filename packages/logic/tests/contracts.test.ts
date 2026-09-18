import { describe, expect, expectTypeOf, it } from "vitest";
import {
  IdListQuerySchema,
  PositiveIntQuerySchema,
  RecurringCreateSchema,
  RenameRuleApplySchema,
  RecurringPatchSchema,
  ReconcileStateQuerySchema,
  TransactionBulkUpdateSchema,
  TransactionCreateSchema,
  TransactionPatchSchema,
  makeSeedBudgetData,
  parseAssignmentResponse,
  parseBudgetDataResponse,
  parseDuplicateAnalysisResponse,
  parseReconcileStateResponse,
  parseRecurringAutoPostResponse,
  parseSnapshotsResponse,
  parseTransactionMutationResult,
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

describe("mutation/read response contracts", () => {
  it("assignment response normalizes numeric money to strings", () => {
    // Raw drizzle row (what PUT /api/assignments actually returns).
    expect(parseAssignmentResponse({ id: 1, categoryId: 2, month: "2026-06", amount: 1500 }))
      .toEqual({ id: 1, categoryId: 2, month: "2026-06", amount: "1500" });
    expect(
      parseAssignmentResponse({ id: 1, categoryId: 2, month: "2026-06", amount: "1500" }).amount
    ).toBe("1500");
    expect(() =>
      parseAssignmentResponse({ id: 1, categoryId: 2, month: "2026-06" })
    ).toThrow(/Invalid assignment response/);
  });

  it("snapshots response accepts a list plus the suggested name", () => {
    const payload = {
      snapshots: [
        { id: "20260907-120000-aaaaaa", name: "before import", createdAt: "2026-09-07T12:00:00.000Z", sizeBytes: 1234 },
      ],
      suggestedName: "Whole Foods -$84.20 (2026-09-06)",
    };
    expect(parseSnapshotsResponse(payload)).toEqual(payload);
    expect(parseSnapshotsResponse({ snapshots: [], suggestedName: "Empty budget" }).snapshots).toEqual([]);
    expect(() => parseSnapshotsResponse({ snapshots: [] })).toThrow(/Invalid snapshots response/);
    expect(() =>
      parseSnapshotsResponse({ snapshots: [{ id: "x" }], suggestedName: "s" })
    ).toThrow(/Invalid snapshots response/);
  });

  it("autopost response accepts full and empty payloads", () => {
    const full = parseRecurringAutoPostResponse({
      postedCount: 2,
      posted: [{ id: 9 }],
      failures: [{ id: 3, payee: "Gym", error: "boom" }],
      capped: [{ id: 4, payee: "Rent", remainingDue: 6 }],
    });
    expect(full.postedCount).toBe(2);
    expect(full.failures).toHaveLength(1);
    expect(parseRecurringAutoPostResponse({}).postedCount).toBeUndefined();
    expect(() => parseRecurringAutoPostResponse({ postedCount: "many" })).toThrow(
      /Invalid autopost response/
    );
  });

  it("reconcile state response mirrors ReconcileState", () => {
    const state = {
      accountId: 1,
      accountName: "Checking",
      workingBalance: 1000,
      unclearedTotal: 200,
      unclearedCount: 1,
      clearedCount: 2,
      reconciledCount: 3,
      lastReconciledAt: null,
      lastReconciledBalance: null,
    };
    expect(parseReconcileStateResponse(state)).toEqual(state);
    expect(() => parseReconcileStateResponse({ ...state, workingBalance: "1000" })).toThrow(
      /Invalid reconcile response/
    );
  });

  it("duplicates response accepts reports with cent-amount entries", () => {
    const entry = {
      id: 7,
      accountId: 1,
      date: "2026-06-01",
      payee: "Shop",
      memo: "",
      amount: -4500,
    };
    const report = {
      groups: [{ fingerprint: "f", keeper: entry, duplicates: [entry] }],
      duplicateCount: 1,
      flaggedCount: 1,
      alreadyFlaggedCount: 0,
      lockedCount: 0,
      clearedCount: 0,
    };
    expect(parseDuplicateAnalysisResponse(report).duplicateCount).toBe(1);
    expect(() => parseDuplicateAnalysisResponse({ groups: [] })).toThrow(
      /Invalid duplicates response/
    );
  });

  it("transaction create response accepts single and split results", () => {
    // Raw single row carries numeric money; only the id is pinned.
    const single = parseTransactionMutationResult({ id: 5, amount: -100 });
    expect(single).toMatchObject({ id: 5 });
    const split = parseTransactionMutationResult({
      parent: { id: 6, amount: -5000 },
      children: [
        { id: 7, amount: -3000 },
        { id: 8, amount: -2000 },
      ],
    });
    if ("parent" in split) {
      expect(split.children).toHaveLength(2);
    } else {
      throw new Error("expected split result");
    }
    expect(() => parseTransactionMutationResult({ ok: true })).toThrow(
      /Invalid transaction response/
    );
  });
});

describe("query-string contracts", () => {
  it("parses comma-separated id lists, rejecting garbage", () => {
    expect(IdListQuerySchema.safeParse("1,2,3")).toMatchObject({ success: true, data: [1, 2, 3] });
    expect(IdListQuerySchema.safeParse("1, abc, 2").success).toBe(true);
    expect(IdListQuerySchema.safeParse("abc").success).toBe(false);
    expect(IdListQuerySchema.safeParse("").success).toBe(false);
    expect(IdListQuerySchema.safeParse("0,-1").success).toBe(false);
  });

  it("parses single positive ints, rejecting zero/negative/junk", () => {
    expect(PositiveIntQuerySchema.safeParse("7")).toMatchObject({ success: true, data: 7 });
    for (const bad of ["0", "-3", "abc", "", "1.5"]) {
      expect(PositiveIntQuerySchema.safeParse(bad).success).toBe(false);
    }
  });

  it("validates reconcile state query params", () => {
    const ok = ReconcileStateQuerySchema.safeParse({ accountId: "3", statementDate: "2026-08-01" });
    expect(ok).toMatchObject({ success: true, data: { accountId: 3 } });
    expect(ReconcileStateQuerySchema.safeParse({ accountId: null }).success).toBe(false);
    expect(
      ReconcileStateQuerySchema.safeParse({ accountId: "3", statementDate: "08/01/2026" }).success
    ).toBe(false);
  });

  it("validates the rename-rule apply payload", () => {
    expect(RenameRuleApplySchema.safeParse({ id: 7 })).toMatchObject({
      success: true,
      data: { id: 7 },
    });
    for (const bad of [{}, { id: 0 }, { id: -3 }, { id: "7" }, { id: 1, extra: true }]) {
      expect(RenameRuleApplySchema.safeParse(bad).success).toBe(false);
    }
  });
});
