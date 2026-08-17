import { describe, expect, it } from "vitest";
import { computeRunningBalances, type RegisterRow } from "../src/register.js";
import type { Transaction } from "../src/types.js";

/* ---------------- helpers ---------------- */

let _id = 0;
const nextId = () => ++_id;

const t = (
  o: Partial<Transaction> & { accountId: number; amount: number; date: string }
): Transaction => ({
  id: nextId(),
  categoryId: null,
  payee: "",
  memo: "",
  status: "c",
  transferAccountId: null,
  parentId: null,
  ...o,
});

const byId = (rows: RegisterRow[], id: number) => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row with id ${id} in output`);
  return r;
};

/* ---------------- tests ---------------- */

describe("computeRunningBalances", () => {
  it("returns [] for an empty input", () => {
    expect(computeRunningBalances([], new Map())).toEqual([]);
  });

  it("anchors the newest row at the account's current balance", () => {
    const rows = [
      t({ accountId: 1, date: "2026-06-30", amount: -10000 }),
      t({ accountId: 1, date: "2026-06-29", amount: -5000 }),
    ];
    const balances = new Map([[1, 100000]]);
    const out = computeRunningBalances(rows, balances);
    expect(byId(out, rows[0]!.id).runningBalance).toBe(100000);
    expect(byId(out, rows[1]!.id).runningBalance).toBe(110000);
  });

  it("walks through multiple rows, accumulating each newer row's signed amount", () => {
    const rows = [
      t({ accountId: 1, date: "2026-06-30", amount: -10000 }),
      t({ accountId: 1, date: "2026-06-25", amount: 50000 }),
      t({ accountId: 1, date: "2026-06-20", amount: -20000 }),
    ];
    const balances = new Map([[1, 100000]]);
    const out = computeRunningBalances(rows, balances);
    expect(byId(out, rows[0]!.id).runningBalance).toBe(100000);
    expect(byId(out, rows[1]!.id).runningBalance).toBe(110000);
    expect(byId(out, rows[2]!.id).runningBalance).toBe(60000);
  });

  it("keeps accounts independent in the per-account view (no anchor)", () => {
    const a = t({ accountId: 1, date: "2026-06-30", amount: -10000 });
    const b = t({ accountId: 2, date: "2026-06-30", amount: 5000 });
    const c = t({ accountId: 1, date: "2026-06-29", amount: 100000 });
    const balances = new Map([
      [1, 500000],
      [2, 20000],
    ]);
    const out = computeRunningBalances([a, b, c], balances);
    expect(byId(out, a.id).runningBalance).toBe(500000);
    expect(byId(out, b.id).runningBalance).toBe(20000);
    expect(byId(out, c.id).runningBalance).toBe(510000);
  });

  it("anchor mode applies the row's amount to the anchor's balance", () => {
    const a = t({ accountId: 1, date: "2026-06-30", amount: -10000 });
    const b = t({ accountId: 2, date: "2026-06-30", amount: 5000 });
    const balances = new Map([
      [1, 100000],
      [2, 50000],
    ]);
    const out = computeRunningBalances([a, b], balances, 1);
    expect(byId(out, a.id).runningBalance).toBe(100000);
    expect(byId(out, b.id).runningBalance).toBe(50000);
  });

  it("applies transfer rows from the source's perspective when not anchored", () => {
    const transfer = t({
      accountId: 1,
      transferAccountId: 2,
      date: "2026-06-30",
      amount: -10000,
    });
    const balances = new Map([
      [1, 100000],
      [2, 50000],
    ]);
    const out = computeRunningBalances([transfer], balances);
    expect(byId(out, transfer.id).runningBalance).toBe(100000);
  });

  it("applies transfer rows with the opposite sign when the anchor is the destination", () => {
    const transfer = t({
      accountId: 1,
      transferAccountId: 2,
      date: "2026-06-30",
      amount: -10000,
    });
    const balances = new Map([
      [1, 100000],
      [2, 50000],
    ]);
    const out = computeRunningBalances([transfer], balances, 2);
    expect(byId(out, transfer.id).runningBalance).toBe(50000);
  });

  it("skips split parents in the walk (children carry the balance effect)", () => {
    const parent = t({ accountId: 1, date: "2026-06-30", amount: -15000 });
    const c1 = t({ accountId: 1, date: "2026-06-30", amount: -10000, parentId: 999 });
    const c2 = t({ accountId: 1, date: "2026-06-30", amount: -5000, parentId: 999 });
    parent.id = 999;
    const balances = new Map([[1, 100000]]);
    const out = computeRunningBalances([parent, c1, c2], balances);
    expect(byId(out, c1.id).runningBalance).toBe(100000);
    expect(byId(out, c2.id).runningBalance).toBe(110000);
  });

  it("mirrors split parents to the post-cluster value (newest child's running balance)", () => {
    const parent = t({ accountId: 1, date: "2026-06-30", amount: -15000 });
    const c1 = t({ accountId: 1, date: "2026-06-30", amount: -10000, parentId: 999 });
    const c2 = t({ accountId: 1, date: "2026-06-30", amount: -5000, parentId: 999 });
    parent.id = 999;
    const balances = new Map([[1, 100000]]);
    const out = computeRunningBalances([parent, c1, c2], balances);
    expect(byId(out, parent.id).runningBalance).toBe(100000);
  });

  it("applies transfer rows to the destination account in All Transactions (no anchor) mode (Issue #14)", () => {
    // Transfer $100 from Account 1 to Account 2 on June 30
    const transfer = t({
      accountId: 1,
      transferAccountId: 2,
      date: "2026-06-30",
      amount: -10000,
    });
    // Older transaction on Account 2 on June 20
    const olderOnAcc2 = t({
      accountId: 2,
      date: "2026-06-20",
      amount: 5000,
    });
    const balances = new Map([
      [1, 90000],  // After transfer: 90000
      [2, 60000],  // After transfer: 60000 (was 50000 before transfer)
    ]);
    const out = computeRunningBalances([transfer, olderOnAcc2], balances);
    // Source row shows current balance of Account 1
    expect(byId(out, transfer.id).runningBalance).toBe(90000);
    // Older row on Account 2 correctly reflects balance prior to inbound transfer (60000 - 10000 = 50000)
    expect(byId(out, olderOnAcc2.id).runningBalance).toBe(50000);
  });

  it("handles string amounts as integer cents", () => {
    const a = t({ accountId: 1, date: "2026-06-30", amount: "10000" as unknown as number });
    const b = t({ accountId: 1, date: "2026-06-20", amount: "-5000" as unknown as number });
    const balances = new Map([[1, 50000]]);
    const out = computeRunningBalances([a, b], balances);
    expect(byId(out, a.id).runningBalance).toBe(50000);
    expect(byId(out, b.id).runningBalance).toBe(40000);
  });

  it("falls back to the row's own account balance when no walk entry exists", () => {
    const a = t({ accountId: 1, date: "2026-06-30", amount: -10000 });
    const balances = new Map([
      [1, 100000],
      [2, 20000],
    ]);
    const out = computeRunningBalances([a], balances, 2);
    expect(byId(out, a.id).runningBalance).toBe(100000);
  });

  it("correctly recomputes running balances when a transfer transaction is deleted", () => {
    const olderRow = t({ accountId: 1, date: "2026-06-15", amount: -2000 });
    const olderAcc2 = t({ accountId: 2, date: "2026-06-10", amount: 10000 });

    // After deleting a -$50 transfer between Acc 1 and Acc 2:
    // Acc 1 balance restored from 48000 to 98000 (before olderRow: 100000)
    // Acc 2 balance restored from 60000 to 10000
    const restoredBalances = new Map([
      [1, 98000],
      [2, 10000],
    ]);
    const out = computeRunningBalances([olderRow, olderAcc2], restoredBalances);
    expect(byId(out, olderRow.id).runningBalance).toBe(98000);
    expect(byId(out, olderAcc2.id).runningBalance).toBe(10000);
  });

  it("correctly recomputes running balances when a split transaction (with transfer child) is deleted", () => {
    const olderRow = t({ accountId: 1, date: "2026-06-15", amount: -5000 });
    const olderAcc2 = t({ accountId: 2, date: "2026-06-10", amount: 20000 });

    // Split had $100 parent: $60 category expense + $40 transfer to Account 2
    // After deletion:
    // Account 1 balance restored from 75000 to 95000
    // Account 2 balance restored from 60000 to 20000
    const restoredBalances = new Map([
      [1, 95000],
      [2, 20000],
    ]);
    const out = computeRunningBalances([olderRow, olderAcc2], restoredBalances);
    expect(byId(out, olderRow.id).runningBalance).toBe(95000);
    expect(byId(out, olderAcc2.id).runningBalance).toBe(20000);
  });
});
