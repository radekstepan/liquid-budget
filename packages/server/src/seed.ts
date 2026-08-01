import { sql } from "drizzle-orm";
import { DEMO_MONTH } from "@ynab/logic";
import type { Db } from "./client.js";
import { accounts, assignments, categoryGroups, categories, recurring, transactions } from "./schema.js";
import { isSeeded } from "./queries/budget.js";

// Re-export so `import { DEMO_MONTH } from "@ynab/server"` still works.
export { DEMO_MONTH };

export function ensureTables(db: Db): void {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      group_label TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      on_budget INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS category_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      is_credit_card_payments INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES category_groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      carryover REAL NOT NULL DEFAULT 0,
      goal_target REAL,
      linked_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE
    );
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0
    );
  `);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS assignments_cat_month_uniq ON assignments (category_id, month);
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      date TEXT NOT NULL,
      payee TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      cleared INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT '',
      parent_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
      transfer_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL
    );
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS recurring (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      payee TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      frequency TEXT NOT NULL DEFAULT 'monthly',
      next_date TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);
}

/**
 * Wipe all budget data.
 * SQLite has no TRUNCATE — delete in dependency order so FK constraints
 * don't fire, then reset the autoincrement sequences.
 * The next call to seedDatabase() will re-populate from scratch.
 */
export async function resetDatabase(db: Db): Promise<void> {
  ensureTables(db);
  await db.delete(recurring);
  await db.delete(transactions);
  await db.delete(assignments);
  await db.delete(categories);
  await db.delete(categoryGroups);
  await db.delete(accounts);
  // Reset sqlite_sequence so IDs restart from 1 on the next insert.
  await db.run(sql`DELETE FROM sqlite_sequence`);
}

export async function seedDatabase(db: Db) {
  ensureTables(db);
  if (await isSeeded(db)) return;

  // ---------------------------------------------------------------------------
  // ACCOUNTS
  // Mirrors the user's actual YNAB4 account list.
  // On-budget: chequing + credit cards.
  // Tracking (on-budget=true, kind=liquid): Susie & Parents reimbursement accounts.
  // Off-budget: investments, home value, mortgage debt.
  // ---------------------------------------------------------------------------
  const acc = await db
    .insert(accounts)
    .values([
      // ── On-budget: liquid ──────────────────────────────────────────────────
      { name: "TD Unlimited Chequing", kind: "liquid",   groupLabel: "Budget Accounts", balance: 10875.55,  onBudget: true,  sort: 0 },
      { name: "EQ Bank",               kind: "liquid",   groupLabel: "Budget Accounts", balance: 103830.79, onBudget: true,  sort: 1 },
      { name: "Scotia e-Chequing",     kind: "liquid",   groupLabel: "Budget Accounts", balance: 458.23,    onBudget: true,  sort: 2 },
      { name: "Cash",                  kind: "liquid",   groupLabel: "Budget Accounts", balance: 116.05,    onBudget: true,  sort: 3 },
      // ── On-budget: credit cards ────────────────────────────────────────────
      { name: "AMEX Cobalt",           kind: "credit",   groupLabel: "Credit Cards",    balance: -3897.84,  onBudget: true,  sort: 4 },
      { name: "Scotia Passport Visa",  kind: "credit",   groupLabel: "Credit Cards",    balance: -103.48,   onBudget: true,  sort: 5 },
      { name: "Rogers World Elite MC", kind: "credit",   groupLabel: "Credit Cards",    balance: 0.00,      onBudget: true,  sort: 6 },
      { name: "Capital One Aspire MC", kind: "credit",   groupLabel: "Credit Cards",    balance: 0.00,      onBudget: true,  sort: 7 },
      // ── Tracking accounts (reimbursement) ─────────────────────────────────
      { name: "Susie",                 kind: "liquid",   groupLabel: "Tracking",        balance: -674.28,   onBudget: true,  sort: 8 },
      { name: "Parents",               kind: "liquid",   groupLabel: "Tracking",        balance: 3735.35,   onBudget: true,  sort: 9 },
      // ── Off-budget: investments ────────────────────────────────────────────
      { name: "Wealthsimple Trade",    kind: "offbudget", groupLabel: "Investments",    balance: 0.00,      onBudget: false, sort: 10 },
      { name: "Wealthsimple TFSA",     kind: "offbudget", groupLabel: "Investments",    balance: 153674.37, onBudget: false, sort: 11 },
      { name: "Wealthsimple RRSP",     kind: "offbudget", groupLabel: "Investments",    balance: 196700.22, onBudget: false, sort: 12 },
      { name: "Manulife GRSP",         kind: "offbudget", groupLabel: "Investments",    balance: 99213.86,  onBudget: false, sort: 13 },
      { name: "EquatePlus SAP",        kind: "offbudget", groupLabel: "Investments",    balance: 2357.41,   onBudget: false, sort: 14 },
      { name: "British Airways Credit",kind: "offbudget", groupLabel: "Investments",    balance: 357.00,    onBudget: false, sort: 15 },
      // ── Off-budget: property ───────────────────────────────────────────────
      { name: "Home Value",            kind: "offbudget", groupLabel: "Property",       balance: 979000.00, onBudget: false, sort: 16 },
      { name: "Mortgage Debt",         kind: "offbudget", groupLabel: "Property",       balance: -660253.55,onBudget: false, sort: 17 },
    ])
    .returning();

  const accByName: Record<string, number> = Object.fromEntries(acc.map((a) => [a.name, a.id]));
  const a = (k: string) => {
    const id = accByName[k];
    if (id == null) throw new Error(`unknown account: ${k}`);
    return id;
  };

  // ---------------------------------------------------------------------------
  // CATEGORY GROUPS
  // ---------------------------------------------------------------------------
  const groups = await db
    .insert(categoryGroups)
    .values([
      { name: "Housing",               sort: 0, isCreditCardPayments: false },
      { name: "Needs",                 sort: 1, isCreditCardPayments: false },
      { name: "Wants",                 sort: 2, isCreditCardPayments: false },
      { name: "Savings & Investments", sort: 3, isCreditCardPayments: false },
      { name: "Credit Card Payments",  sort: 4, isCreditCardPayments: true  },
    ])
    .returning();

  const gid: Record<string, number> = Object.fromEntries(groups.map((g) => [g.name, g.id]));
  const g = (k: string) => {
    const id = gid[k];
    if (id == null) throw new Error(`unknown group: ${k}`);
    return id;
  };

  // ---------------------------------------------------------------------------
  // CATEGORIES
  // ---------------------------------------------------------------------------
  const cats = await db
    .insert(categories)
    .values([
      // Housing
      { groupId: g("Housing"), name: "Mortgage Principal",    sort: 0,  carryover: 0.00,  goalTarget: null },
      { groupId: g("Housing"), name: "Mortgage Interest",     sort: 1,  carryover: 0.00,  goalTarget: null },
      { groupId: g("Housing"), name: "Property Taxes",        sort: 2,  carryover: 0.00,  goalTarget: 8400.00 },
      { groupId: g("Housing"), name: "Condo Fees/HOA",        sort: 3,  carryover: -439.00, goalTarget: null },
      { groupId: g("Housing"), name: "Home Insurance",        sort: 4,  carryover: 0.00,  goalTarget: 2400.00 },
      { groupId: g("Housing"), name: "Home Maintenance",      sort: 5,  carryover: 0.00,  goalTarget: null },

      // Needs
      { groupId: g("Needs"), name: "Rent",                    sort: 0,  carryover: 0.00,  goalTarget: null },
      { groupId: g("Needs"), name: "Utilities, Electricity, Water", sort: 1, carryover: 0.00, goalTarget: null },
      { groupId: g("Needs"), name: "Internet, iPhone",        sort: 2,  carryover: 0.00,  goalTarget: null },
      { groupId: g("Needs"), name: "Household",               sort: 3,  carryover: -1231.18, goalTarget: null },
      { groupId: g("Needs"), name: "Groceries",               sort: 4,  carryover: 159.65, goalTarget: null },
      { groupId: g("Needs"), name: "Dental, Optical, Counselling", sort: 5, carryover: 0.00, goalTarget: 4000.00 },
      { groupId: g("Needs"), name: "Public Transport, Uber, Bike", sort: 6, carryover: -11.93, goalTarget: null },
      { groupId: g("Needs"), name: "Fees, Charges, Loans",    sort: 7,  carryover: -284.47, goalTarget: null },
      { groupId: g("Needs"), name: "Other Needs",             sort: 8,  carryover: 2868.84, goalTarget: null },

      // Wants
      { groupId: g("Wants"), name: "Eat/Drink Out, Alcohol",  sort: 0,  carryover: -1854.85, goalTarget: null },
      { groupId: g("Wants"), name: "Sport, Exercise",         sort: 1,  carryover: 0.00,  goalTarget: null },
      { groupId: g("Wants"), name: "Lessons (Sailing, Guitar)", sort: 2, carryover: -718.60, goalTarget: null },
      { groupId: g("Wants"), name: "Travels, Flights",        sort: 3,  carryover: 0.00,  goalTarget: null },
      { groupId: g("Wants"), name: "Car Rental, Petrol",      sort: 4,  carryover: -1985.81, goalTarget: null },
      { groupId: g("Wants"), name: "Computers, Games, Guitar",sort: 5,  carryover: 2246.11, goalTarget: null },
      { groupId: g("Wants"), name: "Clothing",                sort: 6,  carryover: -459.45, goalTarget: null },
      { groupId: g("Wants"), name: "Work/Family",             sort: 7,  carryover: -3625.87, goalTarget: null },
      { groupId: g("Wants"), name: "Other Wants",             sort: 8,  carryover: 280.99, goalTarget: null },

      // Savings & Investments
      { groupId: g("Savings & Investments"), name: "Retirement",       sort: 0, carryover: 0.00,  goalTarget: null },
      { groupId: g("Savings & Investments"), name: "Manulife GRSP",    sort: 1, carryover: 216.22, goalTarget: null },
      { groupId: g("Savings & Investments"), name: "EquatePlus SAP",   sort: 2, carryover: -1036.54, goalTarget: null },
      { groupId: g("Savings & Investments"), name: "Other Investments", sort: 3, carryover: 0.00, goalTarget: null },

      // Credit Card Payments
      { groupId: g("Credit Card Payments"), name: "AMEX Cobalt",           sort: 0, carryover: 3897.84, goalTarget: null, linkedAccountId: a("AMEX Cobalt") },
      { groupId: g("Credit Card Payments"), name: "Scotia Passport Visa",  sort: 1, carryover: 103.48,  goalTarget: null, linkedAccountId: a("Scotia Passport Visa") },
      { groupId: g("Credit Card Payments"), name: "Rogers World Elite MC", sort: 2, carryover: 0.00,    goalTarget: null, linkedAccountId: a("Rogers World Elite MC") },
      { groupId: g("Credit Card Payments"), name: "Capital One Aspire MC", sort: 3, carryover: 0.00,    goalTarget: null, linkedAccountId: a("Capital One Aspire MC") },
    ])
    .returning();

  const byName = (name: string) => {
    const c = cats.find((c) => c.name === name);
    if (!c) throw new Error(`unknown category: ${name}`);
    return c.id;
  };

  const A = (name: string, amount: number, month = DEMO_MONTH) => ({
    categoryId: byName(name),
    month,
    amount,
  });

  // ---------------------------------------------------------------------------
  // ASSIGNMENTS — June 2026 budget allocations
  // Based on the "Budgeted" column visible in the Budget screen (May/June).
  // ---------------------------------------------------------------------------
  await db.insert(assignments).values([
    // Housing — mortgage payment is the big one
    A("Mortgage Principal",         1800.00),
    A("Mortgage Interest",          2352.97),
    A("Property Taxes",             0.00),      // funded via goal/lump-sum
    A("Condo Fees/HOA",             439.00),
    A("Home Insurance",             0.00),
    A("Home Maintenance",           0.00),

    // Needs
    A("Rent",                       2000.00),   // visible in May budget row
    A("Utilities, Electricity, Water", 150.00),
    A("Internet, iPhone",           200.00),
    A("Household",                  200.00),
    A("Groceries",                  1000.00),
    A("Dental, Optical, Counselling", 400.00),
    A("Public Transport, Uber, Bike", 75.00),
    A("Fees, Charges, Loans",       35.00),
    A("Other Needs",                50.00),

    // Wants
    A("Eat/Drink Out, Alcohol",     1000.00),
    A("Sport, Exercise",            0.00),
    A("Lessons (Sailing, Guitar)",  0.00),
    A("Travels, Flights",           1000.00),
    A("Car Rental, Petrol",         0.00),
    A("Computers, Games, Guitar",   600.00),
    A("Clothing",                   75.60),
    A("Work/Family",                1000.00),
    A("Other Wants",                1000.00),

    // Savings & Investments
    A("Retirement",                 455.50),
    A("Manulife GRSP",              0.00),
    A("EquatePlus SAP",             0.00),
    A("Other Investments",          0.00),
  ]);

  // ---------------------------------------------------------------------------
  // Helper to build a transaction record
  // ---------------------------------------------------------------------------
  const T = (
    account: string,
    category: string | null,
    date: string,
    payee: string,
    amount: number,
    memo = "",
    cleared = true
  ) => ({
    accountId: a(account),
    categoryId: category ? byName(category) : null,
    date,
    payee,
    amount,
    memo,
    cleared,
  });

  // ---------------------------------------------------------------------------
  // TRANSACTIONS — April, May, and June 2026
  // Reflects the patterns visible in the YNAB4 register screenshots.
  // ---------------------------------------------------------------------------
  await db.insert(transactions).values([
    // ── April 2026 ─────────────────────────────────────────────────────────
    // Payroll deposits (SAP Payroll biweekly → TD Chequing via EQ Bank transfers)
    T("EQ Bank", null, "2026-04-15", "SAP Concur", 4428.65, "Income for April"),
    T("EQ Bank", null, "2026-04-29", "SAP Concur", 4428.65, "Income for April"),
    // Mortgage payment to TD (principal + interest split)
    T("TD Unlimited Chequing", "Mortgage Principal", "2026-04-01", "TD Bank", -1800.00, "Housing: Mortgage Principal"),
    T("TD Unlimited Chequing", "Mortgage Interest",  "2026-04-01", "TD Bank", -2352.97, "Housing: Mortgage Interest"),
    // Condo fees
    T("TD Unlimited Chequing", "Condo Fees/HOA", "2026-04-01", "Mountain's Edge MSP", -439.00, "BC405"),
    // Utilities — Fortis BC
    T("AMEX Cobalt", "Utilities, Electricity, Water", "2026-04-25", "Fortis BC", -303.85, ""),
    // Groceries
    T("AMEX Cobalt", "Groceries", "2026-04-05", "Superstore", -187.42, ""),
    T("AMEX Cobalt", "Groceries", "2026-04-12", "Save-On-Foods", -143.60, ""),
    T("AMEX Cobalt", "Groceries", "2026-04-19", "Costco",        -212.33, "Split with Susie"),
    // Dining Out
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-04-08", "Cactus Club",    -142.00, "Split with Susie"),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-04-17", "Jam Café",       -54.20,  ""),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-04-22", "Parallel 49 Brewing", -67.40, "Split with Susie"),
    // Internet
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-04-10", "Telus", -110.00, ""),
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-04-10", "Fido",  -90.00,  ""),
    // Susie reimbursement received
    T("Susie", null, "2026-04-30", "Susie", 320.15, "April shared expenses reimbursement"),

    // ── May 2026 ───────────────────────────────────────────────────────────
    // Payroll
    T("EQ Bank", null, "2026-05-15", "SAP Concur", 4428.65, "Income for May"),
    T("EQ Bank", null, "2026-05-29", "SAP Concur", 4428.65, "Income for May"),
    // Mortgage
    T("TD Unlimited Chequing", "Mortgage Principal", "2026-05-01", "TD Bank", -1800.00, "Housing: Mortgage Principal"),
    T("TD Unlimited Chequing", "Mortgage Interest",  "2026-05-01", "TD Bank", -2352.97, "Housing: Mortgage Interest"),
    // Condo
    T("TD Unlimited Chequing", "Condo Fees/HOA", "2026-05-01", "Mountain's Edge MSP", -439.00, "BC405"),
    // Groceries
    T("AMEX Cobalt", "Groceries", "2026-05-06", "Superstore",   -196.55, ""),
    T("AMEX Cobalt", "Groceries", "2026-05-14", "Save-On-Foods",-138.20, ""),
    T("AMEX Cobalt", "Groceries", "2026-05-21", "T&T Supermarket",-89.35,""),
    T("AMEX Cobalt", "Groceries", "2026-05-28", "Costco",       -245.78, "Split with Susie"),
    // Dining
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-05-10", "Miku Restaurant",  -218.40, "Split with Susie"),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-05-16", "Tacofino",         -58.90,  ""),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-05-23", "Browns Social House",-97.30,"Split with Susie"),
    // Utilities
    T("AMEX Cobalt", "Utilities, Electricity, Water", "2026-05-25", "Fortis BC", -281.29, ""),
    // Internet
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-05-10", "Telus", -110.00, ""),
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-05-10", "Fido",  -90.00,  ""),
    // Household
    T("AMEX Cobalt", "Household", "2026-05-12", "Home Depot",  -94.71,  ""),
    T("AMEX Cobalt", "Household", "2026-05-20", "Ikea",        -163.50, "Split with Susie"),
    // Sailing lessons
    T("TD Unlimited Chequing", "Lessons (Sailing, Guitar)", "2026-05-01", "Jericho Sailing Centre", -718.60, "Annual membership"),
    // Transport
    T("AMEX Cobalt", "Public Transport, Uber, Bike", "2026-05-18", "Uber", -31.93, ""),
    // Susie reimbursement
    T("Susie", null, "2026-05-31", "Susie", 350.40, "May shared expenses reimbursement"),
    // AMEX payment
    T("TD Unlimited Chequing", "AMEX Cobalt", "2026-05-20", "AMEX Payment", -3531.05, "Card payment"),

    // ── June 2026 (DEMO_MONTH) ─────────────────────────────────────────────
    // Payroll — biweekly SAP Concur deposits
    T("EQ Bank", null, "2026-06-16", "SAP Concur", 4152.97, "Income for June"),
    T("EQ Bank", null, "2026-06-30", "SAP Concur", 4152.97, "Income for June"),
    // Bonus
    T("EQ Bank", null, "2026-06-09", "TD Bank",   500.00, "bonus"),
    // Transfer EQ → TD for mortgage
    T("EQ Bank",               null, "2026-06-01", "Transfer: TD Unlimited Chequing", -4152.97, ""),
    T("TD Unlimited Chequing", null, "2026-06-01", "Transfer: EQ Bank",                4152.97, ""),
    // Mortgage split: principal + interest
    T("TD Unlimited Chequing", "Mortgage Principal", "2026-06-01", "TD Bank", -1800.00, "Housing: Mortgage Principal"),
    T("TD Unlimited Chequing", "Mortgage Interest",  "2026-06-01", "TD Bank", -2352.97, "Housing: Mortgage Interest"),
    // Condo fees
    T("TD Unlimited Chequing", "Condo Fees/HOA", "2026-06-02", "Mountain's Edge MSP", -439.00, "BC405"),
    // Internet / phone
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-06-10", "Telus", -110.00, ""),
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-06-10", "Fido",  -90.00,  ""),
    // Utilities — Fortis BC
    T("AMEX Cobalt", "Utilities, Electricity, Water", "2026-06-25", "Fortis BC", -303.85, ""),
    // Groceries
    T("AMEX Cobalt", "Groceries", "2026-06-04", "Superstore",    -203.18, ""),
    T("AMEX Cobalt", "Groceries", "2026-06-11", "Save-On-Foods", -155.42, ""),
    T("AMEX Cobalt", "Groceries", "2026-06-18", "T&T Supermarket",-93.74,""),
    T("AMEX Cobalt", "Groceries", "2026-06-25", "Costco",        -229.06, "Split with Susie"),
    // Dining / drinks
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-06-07", "Published on Main",   -178.50, "Split with Susie"),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-06-13", "St. Augustine's Pub", -87.30,  "Split with Susie"),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-06-20", "Nemesis Coffee",      -42.15,  ""),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-06-26", "Boulevard Kitchen",   -204.80, ""),
    // Household
    T("AMEX Cobalt", "Household", "2026-06-08", "Home Depot",    -73.42,  ""),
    // Transport
    T("AMEX Cobalt", "Public Transport, Uber, Bike", "2026-06-14", "Uber",    -23.50, ""),
    T("AMEX Cobalt", "Public Transport, Uber, Bike", "2026-06-22", "TransLink", -100.00, "3-month pass"),
    // Clothing
    T("AMEX Cobalt", "Clothing", "2026-06-15", "Aritzia",        -189.00, ""),
    // Travel savings
    T("EQ Bank", "Travels, Flights", "2026-06-01", "Air Canada",  -1200.00, "Flights to Europe"),
    // Computers
    T("AMEX Cobalt", "Computers, Games, Guitar", "2026-06-03", "Apple Store", -409.54, "iPad keyboard"),
    // Dental
    T("TD Unlimited Chequing", "Dental, Optical, Counselling", "2026-06-18", "Dr. Smith Dental", -285.23, ""),
    // Work/Family
    T("AMEX Cobalt", "Work/Family", "2026-06-12", "Amazon", -147.92, ""),
    T("AMEX Cobalt", "Work/Family", "2026-06-19", "Indigo Books", -58.35, ""),
    // Retirement / savings transfer
    T("EQ Bank", "Retirement", "2026-06-01", "Wealthsimple TFSA", -455.50, "Monthly TFSA contribution"),
    // Susie shared expense tracking
    T("Susie", null, "2026-06-07", "Published on Main (Susie share)",    -89.25,  "Half of dinner"),
    T("Susie", null, "2026-06-13", "St. Augustine's (Susie share)",      -43.65,  "Half of pub tab"),
    T("Susie", null, "2026-06-25", "Costco groceries (Susie share)",     -114.53, "Half of Costco run"),
    // AMEX payment from TD
    T("TD Unlimited Chequing", "AMEX Cobalt", "2026-06-20", "AMEX Payment", -4152.97, "Card payment"),
    // Fees
    T("TD Unlimited Chequing", "Fees, Charges, Loans", "2026-06-30", "TD Bank", -17.95, "Monthly bank fee"),
  ]);

  // ---------------------------------------------------------------------------
  // RECURRING — scheduled transactions (next dates are 2026-07 or later)
  // ---------------------------------------------------------------------------
  await db.insert(recurring).values([
    // Mortgage — monthly on the 1st
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Mortgage Principal"), payee: "TD Bank", amount: -1800.00,    frequency: "monthly", nextDate: "2026-07-01", active: true },
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Mortgage Interest"),  payee: "TD Bank", amount: -2352.97,    frequency: "monthly", nextDate: "2026-07-01", active: true },
    // Condo fees
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Condo Fees/HOA"),     payee: "Mountain's Edge MSP", amount: -439.00, frequency: "monthly", nextDate: "2026-07-01", active: true },
    // Internet & phone
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Internet, iPhone"),   payee: "Telus",  amount: -110.00, frequency: "monthly", nextDate: "2026-07-10", active: true },
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Internet, iPhone"),   payee: "Fido",   amount: -90.00,  frequency: "monthly", nextDate: "2026-07-10", active: true },
    // Utilities (estimated)
    { accountId: a("AMEX Cobalt"),           categoryId: byName("Utilities, Electricity, Water"), payee: "Fortis BC", amount: -300.00, frequency: "monthly", nextDate: "2026-07-25", active: true },
    // Payroll — biweekly (represented as two monthly entries)
    { accountId: a("EQ Bank"), categoryId: null, payee: "SAP Concur", amount: 4152.97, frequency: "monthly", nextDate: "2026-07-16", active: true },
    { accountId: a("EQ Bank"), categoryId: null, payee: "SAP Concur", amount: 4152.97, frequency: "monthly", nextDate: "2026-07-30", active: true },
    // TFSA contribution
    { accountId: a("EQ Bank"), categoryId: byName("Retirement"), payee: "Wealthsimple TFSA", amount: -455.50, frequency: "monthly", nextDate: "2026-07-01", active: true },
    // Jericho sailing — annual (next year)
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Lessons (Sailing, Guitar)"), payee: "Jericho Sailing Centre", amount: -718.60, frequency: "yearly", nextDate: "2027-05-01", active: true },
  ]);
}
