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

const round2 = (n: number) => Math.round(n * 100) / 100;

/* ---------------- tests ---------------- */

describe("computeRunningBalances", () => {
  it("returns [] for an empty input", () => {
    expect(computeRunningBalances([], new Map())).toEqual([]);
  });

  it("anchors the newest row at the account's current balance", () => {
    const rows = [
      t({ accountId: 1, date: "2026-06-30", amount: -100 }),
      t({ accountId: 1, date: "2026-06-29", amount: -50 }),
    ];
    const balances = new Map([[1, 1000]]);
    const out = computeRunningBalances(rows, balances);
    // Newest row anchors at the current balance.
    expect(round2(byId(out, rows[0]!.id).runningBalance)).toBe(1000);
    // One row older: balance after that row = current − amount(newer row)
    // = 1000 − (−100) = 1100.
    expect(round2(byId(out, rows[1]!.id).runningBalance)).toBe(1100);
  });

  it("walks through multiple rows, accumulating each newer row's signed amount", () => {
    const rows = [
      t({ accountId: 1, date: "2026-06-30", amount: -100 }),
      t({ accountId: 1, date: "2026-06-25", amount: 500 }),
      t({ accountId: 1, date: "2026-06-20", amount: -200 }),
    ];
    const balances = new Map([[1, 1000]]);
    const out = computeRunningBalances(rows, balances);
    // Newest = current.
    expect(round2(byId(out, rows[0]!.id).runningBalance)).toBe(1000);
    // After the +500 inflow (between 06-30 and 06-25) the balance was
    // 1000 − (−100) = 1100.
    expect(round2(byId(out, rows[1]!.id).runningBalance)).toBe(1100);
    // Oldest: pre-newer-rows balance. Newer contributions: -100 + 500
    // = +400. So pre = 1000 − 400 = 600.
    expect(round2(byId(out, rows[2]!.id).runningBalance)).toBe(600);
  });

  it("keeps accounts independent in the per-account view (no anchor)", () => {
    const a = t({ accountId: 1, date: "2026-06-30", amount: -100 });
    const b = t({ accountId: 2, date: "2026-06-30", amount: 50 });
    const c = t({ accountId: 1, date: "2026-06-29", amount: 1000 });
    const balances = new Map([
      [1, 5000],
      [2, 200],
    ]);
    const out = computeRunningBalances([a, b, c], balances);
    expect(round2(byId(out, a.id).runningBalance)).toBe(5000);
    expect(round2(byId(out, b.id).runningBalance)).toBe(200);
    // The older account-1 row accumulates the newer account-1 amount
    // (-100): 5000 − (−100) = 5100.
    expect(round2(byId(out, c.id).runningBalance)).toBe(5100);
  });

  it("anchor mode applies the row's amount to the anchor's balance", () => {
    const a = t({ accountId: 1, date: "2026-06-30", amount: -100 });
    const b = t({ accountId: 2, date: "2026-06-30", amount: 50 });
    const balances = new Map([
      [1, 1000],
      [2, 500],
    ]);
    const out = computeRunningBalances([a, b], balances, 1);
    expect(round2(byId(out, a.id).runningBalance)).toBe(1000);
    // The account-2 row has no anchor walk entry; falls back to its
    // own account's current balance.
    expect(round2(byId(out, b.id).runningBalance)).toBe(500);
  });

  it("applies transfer rows from the source's perspective when not anchored", () => {
    // No anchor: the row is on the source's accountId, so the walk
    // uses the source's perspective.
    const transfer = t({
      accountId: 1,
      transferAccountId: 2,
      date: "2026-06-30",
      amount: -100,
    });
    const balances = new Map([
      [1, 1000],
      [2, 500],
    ]);
    const out = computeRunningBalances([transfer], balances);
    expect(round2(byId(out, transfer.id).runningBalance)).toBe(1000);
  });

  it("applies transfer rows with the opposite sign when the anchor is the destination", () => {
    const transfer = t({
      accountId: 1,
      transferAccountId: 2,
      date: "2026-06-30",
      amount: -100,
    });
    const balances = new Map([
      [1, 1000],
      [2, 500],
    ]);
    const out = computeRunningBalances([transfer], balances, 2);
    // The transfer is the only row on account 2; its running balance
    // equals the current destination balance (500).
    expect(round2(byId(out, transfer.id).runningBalance)).toBe(500);
  });

  it("skips split parents in the walk (children carry the balance effect)", () => {
    const parent = t({ accountId: 1, date: "2026-06-30", amount: -150 });
    const c1 = t({ accountId: 1, date: "2026-06-30", amount: -100, parentId: 999 });
    const c2 = t({ accountId: 1, date: "2026-06-30", amount: -50, parentId: 999 });
    parent.id = 999;
    const balances = new Map([[1, 1000]]);
    const out = computeRunningBalances([parent, c1, c2], balances);
    // Children sorted date-desc by input order: c1, c2. Walk: c1.rb =
    // 1000, bal -= -100 = 1100; c2.rb = 1100, bal -= -50 = 1150.
    expect(round2(byId(out, c1.id).runningBalance)).toBe(1000);
    expect(round2(byId(out, c2.id).runningBalance)).toBe(1100);
  });

  it("mirrors split parents to the post-cluster value (newest child's running balance)", () => {
    const parent = t({ accountId: 1, date: "2026-06-30", amount: -150 });
    const c1 = t({ accountId: 1, date: "2026-06-30", amount: -100, parentId: 999 });
    const c2 = t({ accountId: 1, date: "2026-06-30", amount: -50, parentId: 999 });
    parent.id = 999;
    const balances = new Map([[1, 1000]]);
    const out = computeRunningBalances([parent, c1, c2], balances);
    // Post-cluster = balance right after the entire cluster = running
    // balance of the chronologically-newest child (c1, the first in
    // the date-desc sort). That's 1000.
    expect(round2(byId(out, parent.id).runningBalance)).toBe(1000);
  });

  it("falls back to the row's own account balance when no walk entry exists", () => {
    const a = t({ accountId: 1, date: "2026-06-30", amount: -100 });
    const balances = new Map([
      [1, 1000],
      [2, 200],
    ]);
    // Anchor is account 2; the input row is on account 1 with no
    // transferAccountId, so it doesn't participate in the anchor walk
    // and falls back to its own account's current balance.
    const out = computeRunningBalances([a], balances, 2);
    expect(round2(byId(out, a.id).runningBalance)).toBe(1000);
  });
});
