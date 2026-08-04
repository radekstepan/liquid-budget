/**
 * ProjectionsView.test.tsx
 *
 * Covers the per-month flow calculation in the 12-month liquid-balance
 * projection. The bug being guarded: biweekly recurring items were
 * silently dropped from `perMonth`, so biweekly paychecks / bills
 * didn't influence the projection line.
 *
 *   perMonth = monthlyNet + weeklyNet * 4.33
 *            + biweeklyNet * 2.16 + yearlyNet / 12
 *
 * The Projected-in-12-mo value is rendered both in the "Projected in 12
 * mo" MathCell and in the last row of the table. `getAllByText` is used
 * to assert the value is present in the DOM without tripping the
 * "multiple matches" error from `getByText`.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectionsView } from "../src/ProjectionsView.js";
import { fmt } from "@ynab/logic";
import type {
  Account,
  Category,
  CategoryGroup,
  Recurring,
  RecurringSubTransaction,
} from "@ynab/logic";

function acct(overrides: Partial<Account>): Account {
  return {
    id: 1,
    name: "Chequing",
    kind: "liquid",
    groupLabel: "Budget",
    balance: "0",
    onBudget: true,
    sort: 0,
    ...overrides,
  };
}

const emptyGroups: CategoryGroup[] = [];
const emptyCategories: Category[] = [];

function rec(
  id: number,
  frequency: Recurring["frequency"],
  amount: number,
  active = true
): Recurring {
  return {
    id,
    accountId: 1,
    categoryId: 1,
    payee: `R${id}`,
    amount: String(amount),
    frequency,
    nextDate: "2026-07-01",
    active,
  };
}

function expectedProjected(liquidNow: number, perMonth: number): string {
  return fmt(liquidNow + perMonth * 12);
}

describe("ProjectionsView", () => {
  it("returns perMonth=0 when no recurring items exist", () => {
    const data = {
      accounts: [acct({ id: 1, balance: "1000" })],
      groups: emptyGroups,
      categories: emptyCategories,
      assignments: [],
      transactions: [],
      recurring: [] as Recurring[],
    };
    render(<ProjectionsView data={data} month="2026-07" />);
    // Projected in 12 mo = 1000 + 0*12 = 1000.
    expect(screen.getAllByText("$1,000.00").length).toBeGreaterThan(0);
  });

  it("includes biweekly entries in the projection flow", () => {
    // One biweekly entry of $2000 (e.g. a biweekly paycheck).
    // biweeklyNet = 2000 * 2.16 = 4320.
    // 12-month delta = 4320 * 12 = 51,840.
    const data = {
      accounts: [acct({ id: 1, balance: "0" })],
      groups: emptyGroups,
      categories: emptyCategories,
      assignments: [],
      transactions: [],
      recurring: [rec(1, "biweekly", 2000)],
    };
    render(<ProjectionsView data={data} month="2026-07" />);
    expect(screen.getAllByText(expectedProjected(0, 4320)).length).toBeGreaterThan(0);
  });

  it("combines monthly, weekly, biweekly, and yearly entries correctly", () => {
    // monthly:    -100           → -100
    // weekly:     +50 * 4.33     → +216.5
    // biweekly:   +200 * 2.16    → +432
    // yearly:     +1200 / 12     → +100
    // perMonth                      = +648.5
    // 12-month delta                 = +7,782
    const data = {
      accounts: [acct({ id: 1, balance: "0" })],
      groups: emptyGroups,
      categories: emptyCategories,
      assignments: [],
      transactions: [],
      recurring: [
        rec(1, "monthly", -100),
        rec(2, "weekly", 50),
        rec(3, "biweekly", 200),
        rec(4, "yearly", 1200),
      ],
    };
    render(<ProjectionsView data={data} month="2026-07" />);
    expect(screen.getAllByText(expectedProjected(0, 648.5)).length).toBeGreaterThan(0);
  });

  it("excludes inactive biweekly entries", () => {
    const data = {
      accounts: [acct({ id: 1, balance: "0" })],
      groups: emptyGroups,
      categories: emptyCategories,
      assignments: [],
      transactions: [],
      recurring: [rec(1, "biweekly", 2000, false)],
    };
    render(<ProjectionsView data={data} month="2026-07" />);
    // Inactive → perMonth=0 → projected in 12 mo = 0.
    expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);
  });

  it("ignores transfer biweekly entries (net zero across accounts)", () => {
    // A biweekly transfer is stored with transferAccountId set; the
    // projection logic uses netMonthlyAmount which returns 0 for
    // transfers, so they must not contribute to flow.
    const data = {
      accounts: [acct({ id: 1, balance: "0" })],
      groups: emptyGroups,
      categories: emptyCategories,
      assignments: [],
      transactions: [],
      recurring: [
        {
          ...rec(1, "biweekly", -2000),
          transferAccountId: 2,
        },
      ],
    };
    render(<ProjectionsView data={data} month="2026-07" />);
    expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);
  });

  it("uses split children for biweekly entries (signed sum)", () => {
    // Biweekly split: +5000 gross, -1000 taxes → net 4000.
    // biweeklyNet = 4000 * 2.16 = 8640.
    // 12 months = 103,680.
    const subs: RecurringSubTransaction[] = [
      { id: 1, recurringId: 1, categoryId: 1, amount: "5000", memo: "", sort: 0 },
      { id: 2, recurringId: 1, categoryId: 1, amount: "-1000", memo: "", sort: 1 },
    ];
    const data = {
      accounts: [acct({ id: 1, balance: "0" })],
      groups: emptyGroups,
      categories: emptyCategories,
      assignments: [],
      transactions: [],
      recurring: [
        { ...rec(1, "biweekly", 4000), subTransactions: subs },
      ],
    };
    render(<ProjectionsView data={data} month="2026-07" />);
    expect(screen.getAllByText(expectedProjected(0, 8640)).length).toBeGreaterThan(0);
  });
});
