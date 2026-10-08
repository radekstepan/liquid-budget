import { describe, expect, it } from "vitest";
import {
  applyMergeOverrides,
  isImportedTransaction,
  pickMergePrimary,
  resolveMergedTransaction,
  type MergeableTransaction,
  type MergedTransactionFields,
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

describe("applyMergeOverrides", () => {
  function resolved(): MergedTransactionFields {
    const [primary, secondary] = pickMergePrimary(
      tx({ id: 1, categoryId: 11, memo: "weekly shop" }),
      tx({ id: 2, needsReview: true, payee: "WHOLE FOODS #24" })
    );
    return resolveMergedTransaction({ primary, secondary, sourceAccount: liquid, destAccount: null });
  }

  it("keeps every resolved field when no overrides are given", () => {
    const merged = resolved();
    expect(applyMergeOverrides(merged, {}, { sourceAccount: liquid, destAccount: null })).toEqual(
      merged
    );
  });

  it("overlays plain-field edits and keeps the rest resolved", () => {
    const merged = resolved();
    const next = applyMergeOverrides(
      merged,
      { date: "2026-08-03", payee: "Whole Foods", memo: "edited", amount: -5100, status: "u" },
      { sourceAccount: liquid, destAccount: null }
    );
    expect(next.date).toBe("2026-08-03");
    expect(next.payee).toBe("Whole Foods");
    expect(next.memo).toBe("edited");
    expect(next.amount).toBe(-5100);
    expect(next.status).toBe("u");
    // Untouched resolution survives: category, flag, review marker, payee link.
    expect(next.categoryId).toBe(merged.categoryId);
    expect(next.flagColor).toBe(merged.flagColor);
    expect(next.needsReview).toBe(merged.needsReview);
    expect(next.payeeId).toBe(merged.payeeId);
  });

  it("recomputes income when the category edit leaves a positive inflow uncategorized", () => {
    const merged = resolved();
    const next = applyMergeOverrides(
      merged,
      { categoryId: null, amount: 5000, incomeMonth: "2026-09" },
      { sourceAccount: liquid, destAccount: null }
    );
    expect(next.categoryId).toBeNull();
    expect(next.isIncome).toBe(true);
    expect(next.incomeMonth).toBe("2026-09");
  });

  it("drops income when the category edit categorizes the row", () => {
    const merged = resolveMergedTransaction({
      primary: tx({ id: 2, needsReview: true, categoryId: null, amount: 5000 }),
      secondary: tx({ id: 1, categoryId: null, amount: 5000 }),
      sourceAccount: liquid,
      destAccount: null,
    });
    expect(merged.isIncome).toBe(true);
    const next = applyMergeOverrides(
      merged,
      { categoryId: 11 },
      { sourceAccount: liquid, destAccount: null }
    );
    expect(next.categoryId).toBe(11);
    expect(next.isIncome).toBe(false);
    expect(next.incomeMonth).toBeNull();
  });

  it("nulls the category when the account edit moves onto an off-budget account", () => {
    const merged = resolved();
    expect(merged.categoryId).toBe(11);
    const next = applyMergeOverrides(
      merged,
      { accountId: 9 },
      { sourceAccount: { onBudget: false, kind: "offbudget" }, destAccount: null }
    );
    expect(next.accountId).toBe(9);
    expect(next.categoryId).toBeNull();
    expect(next.isIncome).toBe(false);
  });

  it("defaults a blank transfer payee to the destination name", () => {
    const merged = resolveMergedTransaction({
      primary: tx({ id: 1, transferAccountId: 7, payee: "Transfer : Savings" }),
      secondary: tx({ id: 2 }),
      sourceAccount: liquid,
      destAccount: { onBudget: true },
    });
    const next = applyMergeOverrides(
      merged,
      { payee: "  " },
      { sourceAccount: liquid, destAccount: { onBudget: true }, destAccountName: "Savings" }
    );
    expect(next.payee).toBe("Transfer : Savings");
  });

  it("overlays a flag edit and keeps the resolved flag when untouched", () => {
    const merged = resolveMergedTransaction({
      primary: tx({ id: 2, needsReview: true }),
      secondary: tx({ id: 1, flagColor: "red" }),
      sourceAccount: liquid,
      destAccount: null,
    });
    expect(merged.flagColor).toBe("red");

    expect(
      applyMergeOverrides(merged, {}, { sourceAccount: liquid, destAccount: null }).flagColor
    ).toBe("red");
    expect(
      applyMergeOverrides(merged, { flagColor: "green" }, { sourceAccount: liquid, destAccount: null })
        .flagColor
    ).toBe("green");
    expect(
      applyMergeOverrides(merged, { flagColor: null }, { sourceAccount: liquid, destAccount: null })
        .flagColor
    ).toBeNull();
  });

  it("clears the transfer leg when the destination is nulled", () => {
    const merged = resolveMergedTransaction({
      primary: tx({ id: 1, transferAccountId: 7, payee: "Transfer : Savings" }),
      secondary: tx({ id: 2 }),
      sourceAccount: liquid,
      destAccount: { onBudget: true },
    });
    expect(merged.transferAccountId).toBe(7);
    const next = applyMergeOverrides(
      merged,
      { transferAccountId: null },
      { sourceAccount: liquid, destAccount: null }
    );
    expect(next.transferAccountId).toBeNull();
    expect(next.transferStatus).toBeNull();
  });
});
