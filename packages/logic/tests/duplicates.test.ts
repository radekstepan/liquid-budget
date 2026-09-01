import { describe, expect, it } from "vitest";
import {
  normalizeText,
  duplicateFingerprint,
  findDuplicateGroups,
  buildExistingImportFingerprints,
  identifyImportDuplicates,
  type DuplicateEntry,
} from "../src/duplicates.js";

function row(over: Partial<DuplicateEntry> & { id: number }): DuplicateEntry {
  return {
    accountId: 1,
    date: "2026-06-01",
    payee: "Store",
    memo: "",
    amount: -1000,
    parentId: null,
    transferAccountId: null,
    ...over,
  };
}

describe("normalizeText", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeText("  PHNOM PENH   RESTAURANT  ")).toBe("phnom penh restaurant");
    expect(normalizeText("Uber TRIP")).toBe("uber trip");
  });
});

describe("duplicateFingerprint", () => {
  it("is stable across equivalent inputs", () => {
    const a = duplicateFingerprint({
      accountId: 1,
      date: "2026-06-01",
      amount: -2808,
      payee: "PHNOM PENH   RESTAURANT",
      memo: " LUNCH ",
    });
    const b = duplicateFingerprint({
      accountId: 1,
      date: "2026-06-01",
      amount: -2808,
      payee: "phnom penh restaurant",
      memo: "lunch",
    });
    expect(a).toBe(b);
  });

  it("differs when any field changes", () => {
    const base = {
      accountId: 1,
      date: "2026-06-01",
      amount: -2808,
      payee: "Store",
      memo: "",
    };
    const f = (patch: Partial<typeof base>) => duplicateFingerprint({ ...base, ...patch });
    expect(f({ accountId: 2 })).not.toBe(f({}));
    expect(f({ date: "2026-06-02" })).not.toBe(f({}));
    expect(f({ amount: -2809 })).not.toBe(f({}));
    expect(f({ payee: "Other" })).not.toBe(f({}));
    expect(f({ memo: "hi" })).not.toBe(f({}));
  });

  it("does not collide when fields contain delimiters (BUG-22)", () => {
    const a = duplicateFingerprint({
      accountId: 1,
      date: "2026-06-01",
      amount: -1000,
      payee: "Store|Branch",
      memo: "Lunch",
    });
    const b = duplicateFingerprint({
      accountId: 1,
      date: "2026-06-01",
      amount: -1000,
      payee: "Store",
      memo: "Branch|Lunch",
    });
    expect(a).not.toBe(b);
  });

  it("differs when fitId changes (BUG-16)", () => {
    const a = duplicateFingerprint({
      accountId: 1,
      date: "2026-06-01",
      amount: -450,
      payee: "Coffee Shop",
      memo: "",
      fitId: "FIT-001",
    });
    const b = duplicateFingerprint({
      accountId: 1,
      date: "2026-06-01",
      amount: -450,
      payee: "Coffee Shop",
      memo: "",
      fitId: "FIT-002",
    });
    expect(a).not.toBe(b);
  });
});

describe("findDuplicateGroups", () => {
  it("groups identical plain rows and keeps the first", () => {
    const groups = findDuplicateGroups([
      row({ id: 1 }),
      row({ id: 2 }),
      row({ id: 3, payee: "Other", amount: -2000 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keeper.id).toBe(1);
    expect(groups[0]!.duplicates.map((d) => d.id)).toEqual([2]);
  });

  it("distinguishes same-day, same-payee, same-amount transactions with different memos (BUG-16)", () => {
    const groups = findDuplicateGroups([
      row({ id: 1, date: "2026-06-01", payee: "Coffee Shop", amount: -450, memo: "Morning coffee" }),
      row({ id: 2, date: "2026-06-01", payee: "Coffee Shop", amount: -450, memo: "Afternoon coffee" }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("distinguishes same-day, same-payee, same-amount transactions with different fitIds (BUG-16)", () => {
    const groups = findDuplicateGroups([
      row({ id: 1, date: "2026-06-01", payee: "Coffee Shop", amount: -450, memo: "", fitId: "FIT-001" }),
      row({ id: 2, date: "2026-06-01", payee: "Coffee Shop", amount: -450, memo: "", fitId: "FIT-002" }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("groups same-day transactions when memo and fitId match (BUG-16)", () => {
    const groups = findDuplicateGroups([
      row({ id: 1, date: "2026-06-01", payee: "Coffee Shop", amount: -450, memo: "Coffee", fitId: "FIT-001" }),
      row({ id: 2, date: "2026-06-01", payee: "Coffee Shop", amount: -450, memo: "Coffee", fitId: "FIT-001" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keeper.id).toBe(1);
    expect(groups[0]!.duplicates.map((d) => d.id)).toEqual([2]);
  });

  it("excludes split children and split parents", () => {
    const groups = findDuplicateGroups([
      row({ id: 1 }), // plain duplicate candidate
      row({ id: 2 }),
      row({ id: 3, parentId: 10 }), // split child, excluded
      row({ id: 10, amount: -15000 }), // split parent (has children), excluded
      row({ id: 11, transferAccountId: 2 }), // transfer, excluded
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keeper.id).toBe(1);
    expect(groups[0]!.duplicates.map((d) => d.id)).toEqual([2]);
  });

  it("keeps the earliest existing row as keeper when a CSV row matches", () => {
    const groups = findDuplicateGroups([
      row({ id: 5 }),
      row({ rowNumber: 4, accountId: 1, date: "2026-06-01", payee: "Store", memo: "", amount: -1000 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keeper.id).toBe(5);
    expect(groups[0]!.duplicates.map((d) => d.rowNumber)).toEqual([4]);
  });

  it("handles duplicate rows within a CSV batch (no ids)", () => {
    const groups = findDuplicateGroups([
      row({ rowNumber: 2, accountId: 1, payee: "Store" }),
      row({ rowNumber: 3, accountId: 1, payee: "Store" }),
      row({ rowNumber: 4, accountId: 1, payee: "Store" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keeper.rowNumber).toBe(2);
    expect(groups[0]!.duplicates.map((d) => d.rowNumber)).toEqual([3, 4]);
  });

  it("prefers reconciled rows as keeper over earlier mutable rows (BUG-33)", () => {
    const groups = findDuplicateGroups([
      row({ id: 1, status: "c" }),
      row({ id: 2, status: "r" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keeper.id).toBe(2);
    expect(groups[0]!.duplicates.map((d) => d.id)).toEqual([1]);
  });

  it("preserves relative order among multiple reconciled rows when choosing keeper (BUG-33)", () => {
    const groups = findDuplicateGroups([
      row({ id: 1, status: "c" }),
      row({ id: 2, status: "r" }),
      row({ id: 3, status: "r" }),
      row({ id: 4, status: "u" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keeper.id).toBe(2);
    expect(groups[0]!.duplicates.map((d) => d.id)).toEqual([3, 1, 4]);
  });
});

describe("buildExistingImportFingerprints and identifyImportDuplicates (BUG-21, BUG-34)", () => {
  it("includes split parents in import fingerprints and matches incoming rows", () => {
    const existing = [
      // Split parent: total amount -5000, Costco
      { id: 1, accountId: 1, date: "2026-08-10", payee: "Costco", memo: "Weekly run", amount: -5000, parentId: null },
      // Split children:
      { id: 2, accountId: 1, date: "2026-08-10", payee: "Costco", memo: "Food", amount: -3000, parentId: 1 },
      { id: 3, accountId: 1, date: "2026-08-10", payee: "Costco", memo: "Household", amount: -2000, parentId: 1 },
    ];

    const fps = buildExistingImportFingerprints(1, existing);

    const incoming = [
      { rowNumber: 2, date: "2026-08-10", payee: "Costco", memo: "Weekly run", amountCents: -5000 },
      { rowNumber: 3, date: "2026-08-10", payee: "Costco", memo: "Food", amountCents: -3000 },
    ];

    const result = identifyImportDuplicates(1, fps, incoming);
    // Row 2 matches split parent
    expect(result.duplicateRowNumbers.has(2)).toBe(true);
    // Row 3 does NOT match because child amounts are excluded
    expect(result.duplicateRowNumbers.has(3)).toBe(false);
  });

  it("includes transfers in import fingerprints for source and destination accounts", () => {
    const existing = [
      {
        id: 10,
        accountId: 1,
        transferAccountId: 2,
        date: "2026-08-10",
        payee: "Transfer : Savings",
        memo: "Save",
        amount: -50000,
        parentId: null,
      },
    ];
    const accNames = new Map([
      [1, "Chequing"],
      [2, "Savings"],
    ]);

    // Source account (Chequing)
    const sourceFps = buildExistingImportFingerprints(1, existing, accNames);
    const sourceIncoming = [
      { rowNumber: 2, date: "2026-08-10", payee: "Transfer : Savings", memo: "Save", amountCents: -50000 },
    ];
    const sourceResult = identifyImportDuplicates(1, sourceFps, sourceIncoming);
    expect(sourceResult.duplicateRowNumbers.has(2)).toBe(true);

    // Destination account (Savings)
    const destFps = buildExistingImportFingerprints(2, existing, accNames);
    const destIncoming = [
      { rowNumber: 5, date: "2026-08-10", payee: "Transfer : Chequing", memo: "Save", amountCents: 50000 },
    ];
    const destResult = identifyImportDuplicates(2, destFps, destIncoming);
    expect(destResult.duplicateRowNumbers.has(5)).toBe(true);
  });

  it("includes both raw and renamed fingerprints when rename rules are provided (BUG-34)", () => {
    const existing = [
      {
        id: 1,
        accountId: 1,
        date: "2026-08-10",
        payee: "BCF1",
        memo: "",
        amount: -2808,
      },
    ];
    const renameRules = [
      { id: 1, sourcePattern: "BCF[N]", targetPayee: "BC Ferries", createdAt: "2026-01-01T00:00:00.000Z" },
    ];

    const fps = buildExistingImportFingerprints(1, existing, undefined, renameRules);
    expect(fps.has(duplicateFingerprint({ accountId: 1, date: "2026-08-10", payee: "BCF1", memo: "", amount: -2808 }))).toBe(true);
    expect(fps.has(duplicateFingerprint({ accountId: 1, date: "2026-08-10", payee: "BC Ferries", memo: "", amount: -2808 }))).toBe(true);

    const incoming = [
      { rowNumber: 2, date: "2026-08-10", payee: "BC Ferries", memo: "", amountCents: -2808 },
    ];
    const result = identifyImportDuplicates(1, fps, incoming);
    expect(result.duplicateRowNumbers.has(2)).toBe(true);
  });

  it("permits multiple identical legitimate rows in the same CSV batch and matches existing occurrences 1-to-1 (BUG-35)", () => {
    const existing = [
      { id: 1, accountId: 1, date: "2026-08-10", payee: "Transit", memo: "", amount: -250 },
    ];

    const fps = buildExistingImportFingerprints(1, existing);

    const incoming = [
      { rowNumber: 2, date: "2026-08-10", payee: "Transit", memo: "", amountCents: -250 },
      { rowNumber: 3, date: "2026-08-10", payee: "Transit", memo: "", amountCents: -250 },
    ];

    const result = identifyImportDuplicates(1, fps, incoming);
    // Row 2 matches the 1 existing transaction in DB
    expect(result.duplicateRowNumbers.has(2)).toBe(true);
    // Row 3 is a legitimate 2nd transit charge in the batch and is NOT marked as duplicate
    expect(result.duplicateRowNumbers.has(3)).toBe(false);
  });

  it("does not flag identical rows in a batch as duplicates when no existing ledger transaction matches (BUG-35)", () => {
    const fps = buildExistingImportFingerprints(1, []);

    const incoming = [
      { rowNumber: 2, date: "2026-08-10", payee: "Vending", memo: "", amountCents: -175 },
      { rowNumber: 3, date: "2026-08-10", payee: "Vending", memo: "", amountCents: -175 },
    ];

    const result = identifyImportDuplicates(1, fps, incoming);
    expect(result.duplicateRowNumbers.size).toBe(0);
    expect(result.duplicates).toHaveLength(0);
  });
});
