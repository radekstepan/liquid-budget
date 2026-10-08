import { describe, expect, it } from "vitest";
import {
  isImportedTransaction,
  pickMergePrimary,
  resolveMergedTransaction,
  type MergeableTransaction,
} from "../src/merge.js";

function tx(overrides: Partial<MergeableTransaction> & { id: number }): MergeableTransaction {
  return {
    accountId: 1,
    transferAccountId: null,
    categoryId: null,
    date: "2026-08-01",
    payee: "Payee",
    payeeId: null,
    memo: "",
    amount: -5000,
    status: "c",
    transferStatus: null,
    flagColor: null,
    needsReview: false,
    entityId: null,
    transferEntityId: null,
    isIncome: false,
    incomeMonth: null,
    ...overrides,
  };
}

const liquid = { onBudget: true, kind: "liquid" };

describe("isImportedTransaction", () => {
  it("treats needsReview rows (fresh CSV imports) as imported", () => {
    expect(isImportedTransaction(tx({ id: 1, needsReview: true }))).toBe(true);
  });

  it("treats rows with a YNAB4 entityId as imported", () => {
    expect(isImportedTransaction(tx({ id: 1, entityId: "YNAB4:abc" }))).toBe(true);
  });

  it("treats plain manually created rows as not imported", () => {
    expect(isImportedTransaction(tx({ id: 1 }))).toBe(false);
  });
});

describe("pickMergePrimary", () => {
  it("prefers the imported transaction regardless of argument order", () => {
    const manual = tx({ id: 1 });
    const imported = tx({ id: 2, needsReview: true });
    expect(pickMergePrimary(manual, imported)[0]?.id).toBe(2);
    expect(pickMergePrimary(imported, manual)[0]?.id).toBe(2);
  });

  it("prefers YNAB4-imported rows over manual rows", () => {
    const manual = tx({ id: 1 });
    const imported = tx({ id: 2, entityId: "YNAB4:abc" });
    expect(pickMergePrimary(manual, imported)[0]?.id).toBe(2);
  });

  it("breaks ties between two manual rows by lower id", () => {
    const [primary, secondary] = pickMergePrimary(tx({ id: 9 }), tx({ id: 4 }));
    expect(primary.id).toBe(4);
    expect(secondary.id).toBe(9);
  });

  it("breaks ties between two imported rows by lower id", () => {
    const [primary, secondary] = pickMergePrimary(
      tx({ id: 7, needsReview: true }),
      tx({ id: 3, needsReview: true })
    );
    expect(primary.id).toBe(3);
    expect(secondary.id).toBe(7);
  });
});

describe("resolveMergedTransaction", () => {
  it("gives imported data priority and fills gaps from the manual row", () => {
    const manual = tx({
      id: 1,
      categoryId: 11,
      date: "2026-08-02",
      payee: "Whole Foods",
      memo: "weekly shop",
      amount: -4999,
      status: "c",
      flagColor: "red",
    });
    const imported = tx({
      id: 2,
      needsReview: true,
      categoryId: null,
      date: "2026-08-01",
      payee: "WHOLE FOODS #24",
      memo: "",
      amount: -5000,
      status: "u",
      flagColor: null,
    });
    const [primary, secondary] = pickMergePrimary(manual, imported);
    const merged = resolveMergedTransaction({
      primary,
      secondary,
      sourceAccount: liquid,
      destAccount: null,
    });

    // Imported bank data wins.
    expect(merged.date).toBe("2026-08-01");
    expect(merged.amount).toBe(-5000);
    expect(merged.payee).toBe("WHOLE FOODS #24");
    expect(merged.status).toBe("u");
    expect(merged.needsReview).toBe(true);
    // Manual curation fills gaps the import left empty.
    expect(merged.categoryId).toBe(11);
    expect(merged.memo).toBe("weekly shop");
    expect(merged.flagColor).toBe("red");
    expect(merged.accountId).toBe(1);
    expect(merged.transferAccountId).toBeNull();
    expect(merged.isIncome).toBe(false);
    expect(merged.incomeMonth).toBeNull();
  });

  it("keeps the primary payee when both rows have one", () => {
    const [primary, secondary] = pickMergePrimary(tx({ id: 1 }), tx({ id: 2 }));
    const merged = resolveMergedTransaction({
      primary: { ...primary, payee: "Primary Mart" },
      secondary: { ...secondary, payee: "Secondary Mart" },
      sourceAccount: liquid,
      destAccount: null,
    });
    expect(merged.payee).toBe("Primary Mart");
  });

  it("falls back to the secondary payee only when the primary payee is empty", () => {
    const [primary, secondary] = pickMergePrimary(tx({ id: 1 }), tx({ id: 2 }));
    const merged = resolveMergedTransaction({
      primary: { ...primary, payee: "" },
      secondary: { ...secondary, payee: "Secondary Mart" },
      sourceAccount: liquid,
      destAccount: null,
    });
    expect(merged.payee).toBe("Secondary Mart");
  });

  it("drops the internal duplicate marker (the duplication is resolved by the merge)", () => {
    const [primary, secondary] = pickMergePrimary(tx({ id: 1 }), tx({ id: 2 }));
    const merged = resolveMergedTransaction({
      primary: { ...primary, flagColor: "duplicate" },
      secondary: { ...secondary, flagColor: null },
      sourceAccount: liquid,
      destAccount: null,
    });
    expect(merged.flagColor).toBeNull();

    const kept = resolveMergedTransaction({
      primary: { ...primary, flagColor: "duplicate" },
      secondary: { ...secondary, flagColor: "green" },
      sourceAccount: liquid,
      destAccount: null,
    });
    expect(kept.flagColor).toBe("green");
  });

  it("keeps the primary transfer shape and ignores the secondary regular category", () => {
    const regular = tx({ id: 1, categoryId: 11, payee: "Manual transfer note" });
    const transfer = tx({
      id: 2,
      needsReview: true,
      transferAccountId: 7,
      categoryId: null,
      payee: "Transfer : Savings",
      transferStatus: "u",
    });
    const [primary, secondary] = pickMergePrimary(regular, transfer);
    const merged = resolveMergedTransaction({
      primary,
      secondary,
      sourceAccount: liquid,
      destAccount: { onBudget: true, kind: "liquid" },
    });
    expect(merged.transferAccountId).toBe(7);
    expect(merged.categoryId).toBeNull();
    expect(merged.payee).toBe("Transfer : Savings");
    expect(merged.transferStatus).toBe("u");
  });

  it("recomputes income when the merged row ends up categorized", () => {
    const manual = tx({ id: 1, categoryId: 11, amount: 5000 });
    const imported = tx({ id: 2, needsReview: true, categoryId: null, amount: 5000, isIncome: true });
    const [primary, secondary] = pickMergePrimary(manual, imported);
    const merged = resolveMergedTransaction({
      primary,
      secondary,
      sourceAccount: liquid,
      destAccount: null,
    });
    expect(merged.categoryId).toBe(11);
    expect(merged.isIncome).toBe(false);
    expect(merged.incomeMonth).toBeNull();
  });

  it("keeps income with the secondary incomeMonth fallback when still uncategorized", () => {
    const manual = tx({ id: 1, categoryId: null, amount: 5000, incomeMonth: "2026-09" });
    const imported = tx({ id: 2, needsReview: true, categoryId: null, amount: 5000, incomeMonth: null });
    const [primary, secondary] = pickMergePrimary(manual, imported);
    const merged = resolveMergedTransaction({
      primary,
      secondary,
      sourceAccount: liquid,
      destAccount: null,
    });
    expect(merged.categoryId).toBeNull();
    expect(merged.isIncome).toBe(true);
    expect(merged.incomeMonth).toBe("2026-09");
  });

  it("forces off-budget rows to stay uncategorized", () => {
    const [primary, secondary] = pickMergePrimary(tx({ id: 1, categoryId: 11 }), tx({ id: 2 }));
    const merged = resolveMergedTransaction({
      primary,
      secondary,
      sourceAccount: { onBudget: false, kind: "offbudget" },
      destAccount: null,
    });
    expect(merged.categoryId).toBeNull();
    expect(merged.isIncome).toBe(false);
  });
});
