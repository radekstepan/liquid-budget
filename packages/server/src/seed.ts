import type { Database } from "./client.js";
import { accounts, assignments, categoryGroups, categories, recurring, transactions } from "./schema.js";
import { isSeeded } from "./queries/budget.js";

export const DEMO_MONTH = "2025-07";

export async function seedDatabase(db: Database) {
  if (await isSeeded(db)) return;

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

  const accByName: Record<string, number> = Object.fromEntries(acc.map((a) => [a.name, a.id]));

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

  const gid: Record<string, number> = Object.fromEntries(groups.map((g) => [g.name, g.id]));
  const g = (k: string) => {
    const id = gid[k];
    if (id == null) throw new Error(`unknown group ${k}`);
    return id;
  };
  const a = (k: string) => {
    const id = accByName[k];
    if (id == null) throw new Error(`unknown account ${k}`);
    return id;
  };

  const cats = await db
    .insert(categories)
    .values([
      { groupId: g("Discretionary"), name: "Groceries", sort: 0, carryover: "18.50" },
      { groupId: g("Discretionary"), name: "Household", sort: 1, carryover: "12.00" },
      { groupId: g("Discretionary"), name: "Dining Out", sort: 2, carryover: "0.00" },
      { groupId: g("Monthly Expenses"), name: "Mortgage", sort: 0, carryover: "0.00" },
      { groupId: g("Monthly Expenses"), name: "Electric", sort: 1, carryover: "0.00" },
      { groupId: g("Monthly Expenses"), name: "Internet", sort: 2, carryover: "0.00" },
      { groupId: g("Monthly Expenses"), name: "Netflix", sort: 3, carryover: "0.00" },
      { groupId: g("Scheduled Expenses"), name: "Pest Control", sort: 0, carryover: "0.00" },
      { groupId: g("Scheduled Expenses"), name: "Home Insurance", sort: 1, carryover: "0.00", goalTarget: "1000.00" },
      { groupId: g("Scheduled Expenses"), name: "Amazon Prime", sort: 2, carryover: "18.00" },
      { groupId: g("Savings"), name: "Rainy Day", sort: 0, carryover: "0.00" },
      { groupId: g("Savings"), name: "Retirement Fund", sort: 1, carryover: "0.00" },
      { groupId: g("Credit Card Payments"), name: "Chase", sort: 0, carryover: "823.47", linkedAccountId: a("Chase") },
      { groupId: g("Credit Card Payments"), name: "Visa", sort: 1, carryover: "1450.00", linkedAccountId: a("Visa") },
      { groupId: g("Credit Card Payments"), name: "Amex", sort: 2, carryover: "412.30", linkedAccountId: a("Amex") },
    ])
    .returning();

  const byName = (name: string) => cats.find((c) => c.name === name)!.id;

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

  const T = (
    account: string,
    category: string | null,
    date: string,
    payee: string,
    amount: string,
    memo = ""
  ) => ({
    accountId: a(account),
    categoryId: category ? byName(category) : null,
    date,
    payee,
    amount,
    memo,
    cleared: true,
  });

  await db.insert(transactions).values([
    T("Checking", "Groceries", "2025-07-03", "Whole Foods", "-102.34"),
    T("Chase", "Groceries", "2025-07-09", "Trader Joe's", "-87.16"),
    T("Checking", "Groceries", "2025-07-16", "Safeway", "-120.00"),
    T("Visa", "Groceries", "2025-07-24", "Costco", "-79.00"),
    T("Amex", "Household", "2025-07-05", "Target", "-42.42"),
    T("Chase", "Household", "2025-07-18", "Amazon", "-25.00"),
    T("Visa", "Dining Out", "2025-07-06", "Cheesecake Factory", "-85.00"),
    T("Chase", "Dining Out", "2025-07-11", "Chipotle", "-45.50"),
    T("Visa", "Dining Out", "2025-07-19", "Sushi Palace", "-120.00"),
    T("Amex", "Dining Out", "2025-07-27", "Starbucks", "-49.50"),
    T("Checking", "Mortgage", "2025-07-01", "Wells Fargo Home Mortgage", "-1850.00"),
    T("Checking", "Electric", "2025-07-14", "PG&E", "-143.27"),
    T("Visa", "Amazon Prime", "2025-07-21", "Amazon Prime", "-180.00", "Annual membership"),
    T("Checking", null, "2025-07-01", "Acme Corp Payroll", "3200.00", "Paycheck"),
    T("Checking", null, "2025-07-15", "Acme Corp Payroll", "3200.00", "Paycheck"),
    T("Checking", "Visa", "2025-07-20", "Visa Payment", "-300.00", "Card payment"),
  ]);

  await db.insert(recurring).values([
    { accountId: a("Checking"), categoryId: byName("Mortgage"), payee: "Wells Fargo Home Mortgage", amount: "-1850.00", frequency: "monthly", nextDate: "2025-08-01", active: true },
    { accountId: a("Checking"), categoryId: byName("Netflix"), payee: "Netflix", amount: "-16.00", frequency: "monthly", nextDate: "2025-08-12", active: true },
    { accountId: a("Checking"), categoryId: byName("Internet"), payee: "Comcast", amount: "-80.00", frequency: "monthly", nextDate: "2025-08-08", active: true },
    { accountId: a("Checking"), categoryId: null, payee: "Acme Corp Payroll", amount: "3200.00", frequency: "monthly", nextDate: "2025-08-01", active: true },
    { accountId: a("Amex"), categoryId: byName("Pest Control"), payee: "TerminatorX Pest", amount: "-45.00", frequency: "monthly", nextDate: "2025-08-15", active: true },
  ]);
}
