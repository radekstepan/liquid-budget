import { db } from "@/db";
import {
  accounts,
  categoryGroups,
  categories,
  assignments,
  transactions,
  recurring,
} from "@/db/schema";
import { sql } from "drizzle-orm";

export const DEMO_MONTH = "2025-07";

export async function isSeeded(): Promise<boolean> {
  const rows = await db.execute<{ count: string }>(
    sql`select count(*)::int as count from ${accounts}`
  );
  const count = Number(rows.rows[0]?.count ?? 0);
  return count > 0;
}

export async function seedDatabase() {
  const already = await isSeeded();
  if (already) return;

  // ---- Accounts ----
  const acc = await db
    .insert(accounts)
    .values([
      { name: "Cash", kind: "liquid", groupLabel: "Liquid", balance: "320.00", onBudget: true, sort: 0 },
      { name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "1658.08", onBudget: true, sort: 1 },
      { name: "Savings", kind: "liquid", groupLabel: "Liquid", balance: "1500.00", onBudget: true, sort: 2 },
      { name: "Chase", kind: "credit", groupLabel: "Credit Cards", balance: "-823.47", onBudget: true, sort: 3 },
      { name: "Visa", kind: "credit", groupLabel: "Credit Cards", balance: "-1450.00", onBudget: true, sort: 4 },
      { name: "Amex", kind: "credit", groupLabel: "Credit Cards", balance: "-412.30", onBudget: true, sort: 5 },
      { name: "Retirement", kind: "offbudget", groupLabel: "Retirement", balance: "58000.00", onBudget: false, sort: 6 },
    ])
    .returning();

  const accByName = Object.fromEntries(acc.map((a) => [a.name, a.id]));

  // ---- Category groups ----
  const groups = await db
    .insert(categoryGroups)
    .values([
      { name: "Discretionary", sort: 0, isCreditCardPayments: false },
      { name: "Monthly Expenses", sort: 1, isCreditCardPayments: false },
      { name: "Scheduled Expenses", sort: 2, isCreditCardPayments: false },
      { name: "Savings", sort: 3, isCreditCardPayments: false },
      { name: "Credit Card Payments", sort: 4, isCreditCardPayments: true },
    ])
    .returning();

  const gid = Object.fromEntries(groups.map((g) => [g.name, g.id]));

  // ---- Categories ----
  // carryover chosen so available = carryover + assigned + outflow matches screenshot
  const cats = await db
    .insert(categories)
    .values([
      // Discretionary
      { groupId: gid["Discretionary"], name: "Groceries", sort: 0, carryover: "18.50" },
      { groupId: gid["Discretionary"], name: "Household", sort: 1, carryover: "12.00" },
      { groupId: gid["Discretionary"], name: "Dining Out", sort: 2, carryover: "0.00" },
      // Monthly Expenses
      { groupId: gid["Monthly Expenses"], name: "Mortgage", sort: 0, carryover: "0.00" },
      { groupId: gid["Monthly Expenses"], name: "Electric", sort: 1, carryover: "0.00" },
      { groupId: gid["Monthly Expenses"], name: "Internet", sort: 2, carryover: "0.00" },
      { groupId: gid["Monthly Expenses"], name: "Netflix", sort: 3, carryover: "0.00" },
      // Scheduled Expenses
      { groupId: gid["Scheduled Expenses"], name: "Pest Control", sort: 0, carryover: "0.00" },
      { groupId: gid["Scheduled Expenses"], name: "Home Insurance", sort: 1, carryover: "0.00", goalTarget: "1000.00" },
      { groupId: gid["Scheduled Expenses"], name: "Amazon Prime", sort: 2, carryover: "18.00" },
      // Savings
      { groupId: gid["Savings"], name: "Rainy Day", sort: 0, carryover: "0.00" },
      { groupId: gid["Savings"], name: "Retirement Fund", sort: 1, carryover: "0.00" },
      // Credit Card Payments (linked to accounts)
      { groupId: gid["Credit Card Payments"], name: "Chase", sort: 0, carryover: "823.47", linkedAccountId: accByName["Chase"] },
      { groupId: gid["Credit Card Payments"], name: "Visa", sort: 1, carryover: "1450.00", linkedAccountId: accByName["Visa"] },
      { groupId: gid["Credit Card Payments"], name: "Amex", sort: 2, carryover: "412.30", linkedAccountId: accByName["Amex"] },
    ])
    .returning();

  const cid = Object.fromEntries(cats.map((c) => [c.name + "@" + c.groupId, c.id]));
  // helper to fetch by unique names (names unique across our seed except Chase/Visa/Amex used only in CC group)
  const byName = (name: string) => cats.find((c) => c.name === name)!.id;

  // ---- Assignments for DEMO_MONTH ----
  const A = (name: string, amount: string) => ({
    categoryId: byName(name),
    month: DEMO_MONTH,
    amount,
  });

  await db.insert(assignments).values([
    A("Groceries", "550.00"),
    A("Household", "100.00"),
    A("Dining Out", "200.00"),
    A("Mortgage", "1850.00"),
    A("Electric", "160.00"),
    A("Internet", "80.00"),
    A("Netflix", "16.00"),
    A("Pest Control", "45.00"),
    A("Home Insurance", "110.00"),
    A("Amazon Prime", "180.00"),
    A("Rainy Day", "400.00"),
    A("Retirement Fund", "300.00"),
  ]);

  // ---- Transactions for DEMO_MONTH (outflows) ----
  const T = (
    account: string,
    category: string | null,
    date: string,
    payee: string,
    amount: string,
    memo = ""
  ) => ({
    accountId: accByName[account],
    categoryId: category ? byName(category) : null,
    date,
    payee,
    amount,
    memo,
    cleared: true,
  });

  await db.insert(transactions).values([
    // Groceries -388.50
    T("Checking", "Groceries", "2025-07-03", "Whole Foods", "-102.34"),
    T("Chase", "Groceries", "2025-07-09", "Trader Joe's", "-87.16"),
    T("Checking", "Groceries", "2025-07-16", "Safeway", "-120.00"),
    T("Visa", "Groceries", "2025-07-24", "Costco", "-79.00"),
    // Household -67.42
    T("Amex", "Household", "2025-07-05", "Target", "-42.42"),
    T("Chase", "Household", "2025-07-18", "Amazon", "-25.00"),
    // Dining Out -300.00
    T("Visa", "Dining Out", "2025-07-06", "Cheesecake Factory", "-85.00"),
    T("Chase", "Dining Out", "2025-07-11", "Chipotle", "-45.50"),
    T("Visa", "Dining Out", "2025-07-19", "Sushi Palace", "-120.00"),
    T("Amex", "Dining Out", "2025-07-27", "Starbucks", "-49.50"),
    // Mortgage -1850
    T("Checking", "Mortgage", "2025-07-01", "Wells Fargo Home Mortgage", "-1850.00"),
    // Electric -143.27
    T("Checking", "Electric", "2025-07-14", "PG&E", "-143.27"),
    // Amazon Prime -180
    T("Visa", "Amazon Prime", "2025-07-21", "Amazon Prime", "-180.00", "Annual membership"),
    // Income
    T("Checking", null, "2025-07-01", "Acme Corp Payroll", "3200.00", "Paycheck"),
    T("Checking", null, "2025-07-15", "Acme Corp Payroll", "3200.00", "Paycheck"),
    // Credit card payment (Visa) -300 outflow from the payment pool
    T("Checking", "Visa", "2025-07-20", "Visa Payment", "-300.00", "Card payment"),
  ]);

  // ---- Recurring templates ----
  await db.insert(recurring).values([
    {
      accountId: accByName["Checking"],
      categoryId: byName("Mortgage"),
      payee: "Wells Fargo Home Mortgage",
      amount: "-1850.00",
      frequency: "monthly",
      nextDate: "2025-08-01",
      active: true,
    },
    {
      accountId: accByName["Checking"],
      categoryId: byName("Netflix"),
      payee: "Netflix",
      amount: "-16.00",
      frequency: "monthly",
      nextDate: "2025-08-12",
      active: true,
    },
    {
      accountId: accByName["Checking"],
      categoryId: byName("Internet"),
      payee: "Comcast",
      amount: "-80.00",
      frequency: "monthly",
      nextDate: "2025-08-08",
      active: true,
    },
    {
      accountId: accByName["Checking"],
      categoryId: null,
      payee: "Acme Corp Payroll",
      amount: "3200.00",
      frequency: "monthly",
      nextDate: "2025-08-01",
      active: true,
    },
    {
      accountId: accByName["Amex"],
      categoryId: byName("Pest Control"),
      payee: "TerminatorX Pest",
      amount: "-45.00",
      frequency: "monthly",
      nextDate: "2025-08-15",
      active: true,
    },
  ]);

  // silence unused var lint for cid map (kept for potential future use)
  void cid;
}
