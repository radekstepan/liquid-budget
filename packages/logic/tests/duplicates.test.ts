import { describe, expect, it } from "vitest";
import {
  normalizeText,
  duplicateFingerprint,
  findDuplicateGroups,
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
});
