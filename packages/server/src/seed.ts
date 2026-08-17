import { eq, sql } from "drizzle-orm";
import { DEMO_MONTH } from "@ynab/logic";
import type { Db } from "./client.js";
import { accounts, assignments, categoryGroups, categories, recurring, recurringSubTransactions, transactions } from "./schema.js";
import { isSeeded } from "./queries/budget.js";

// Re-export so `import { DEMO_MONTH } from "@ynab/server"` still works.
export { DEMO_MONTH };

/**
 * Wipe all budget data.
 * SQLite has no TRUNCATE — delete in dependency order so FK constraints
 * don't fire, then reset the autoincrement sequences.
 * The next call to seedDatabase() will re-populate from scratch.
 */
export async function resetDatabase(db: Db, isNested = false): Promise<void> {
  if (!isNested) db.run(sql`BEGIN`);
  try {
    await db.delete(recurringSubTransactions);
    await db.delete(recurring);
    await db.delete(transactions);
    await db.delete(assignments);
    await db.delete(categories);
    await db.delete(categoryGroups);
    await db.delete(accounts);
    // Reset sqlite_sequence so IDs restart from 1 on the next insert.
    await db.run(sql`DELETE FROM sqlite_sequence`);
    if (!isNested) db.run(sql`COMMIT`);
  } catch (err) {
    if (!isNested) db.run(sql`ROLLBACK`);
    throw err;
  }
}

export async function seedDatabase(db: Db) {
  if (await isSeeded(db)) return;

  db.run(sql`BEGIN`);
  try {
    // ---------------------------------------------------------------------------
    // ACCOUNTS (amounts in cents)
    // ---------------------------------------------------------------------------
  const acc = await db
    .insert(accounts)
    .values([
      // ── On-budget: liquid ──────────────────────────────────────────────────
      { name: "TD Unlimited Chequing", kind: "liquid",   groupLabel: "Budget Accounts", balance: 1087555,  onBudget: true,  sort: 0 },
      { name: "EQ Bank",               kind: "liquid",   groupLabel: "Budget Accounts", balance: 10383079, onBudget: true,  sort: 1 },
      { name: "Scotia e-Chequing",     kind: "liquid",   groupLabel: "Budget Accounts", balance: 45823,    onBudget: true,  sort: 2 },
      { name: "Cash",                  kind: "liquid",   groupLabel: "Budget Accounts", balance: 11605,    onBudget: true,  sort: 3 },
      // ── On-budget: credit cards ────────────────────────────────────────────
      { name: "AMEX Cobalt",           kind: "credit",   groupLabel: "Credit Cards",    balance: -389784,  onBudget: true,  sort: 4 },
      { name: "Scotia Passport Visa",  kind: "credit",   groupLabel: "Credit Cards",    balance: -10348,   onBudget: true,  sort: 5 },
      { name: "Rogers World Elite MC", kind: "credit",   groupLabel: "Credit Cards",    balance: 0,        onBudget: true,  sort: 6 },
      { name: "Capital One Aspire MC", kind: "credit",   groupLabel: "Credit Cards",    balance: 0,        onBudget: true,  sort: 7 },
      // ── Tracking accounts (reimbursement) ─────────────────────────────────
      { name: "Susie",                 kind: "liquid",   groupLabel: "Tracking",        balance: -67428,   onBudget: true,  sort: 8 },
      { name: "Parents",               kind: "liquid",   groupLabel: "Tracking",        balance: 373535,   onBudget: true,  sort: 9 },
      // ── Off-budget: investments ────────────────────────────────────────────
      { name: "Wealthsimple Trade",    kind: "offbudget", groupLabel: "Investments",    balance: 0,        onBudget: false, sort: 10 },
      { name: "Wealthsimple TFSA",     kind: "offbudget", groupLabel: "Investments",    balance: 15367437, onBudget: false, sort: 11 },
      { name: "Wealthsimple RRSP",     kind: "offbudget", groupLabel: "Investments",    balance: 19670022, onBudget: false, sort: 12 },
      { name: "Manulife GRSP",         kind: "offbudget", groupLabel: "Investments",    balance: 9921386,  onBudget: false, sort: 13 },
      { name: "EquatePlus SAP",        kind: "offbudget", groupLabel: "Investments",    balance: 235741,   onBudget: false, sort: 14 },
      { name: "British Airways Credit",kind: "offbudget", groupLabel: "Investments",    balance: 35700,    onBudget: false, sort: 15 },
      // ── Off-budget: property ───────────────────────────────────────────────
      { name: "Home Value",            kind: "offbudget", groupLabel: "Property",       balance: 97900000, onBudget: false, sort: 16 },
      { name: "Mortgage Debt",         kind: "offbudget", groupLabel: "Property",       balance: -66025355,onBudget: false, sort: 17 },
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
  // CATEGORIES (amounts in cents)
  // ---------------------------------------------------------------------------
  const cats = await db
    .insert(categories)
    .values([
      // Housing
      { groupId: g("Housing"), name: "Mortgage Principal",    sort: 0,  carryover: 0,       goalTarget: null },
      { groupId: g("Housing"), name: "Mortgage Interest",     sort: 1,  carryover: 0,       goalTarget: null },
      { groupId: g("Housing"), name: "Property Taxes",        sort: 2,  carryover: 0,       goalTarget: 840000 },
      { groupId: g("Housing"), name: "Condo Fees/HOA",        sort: 3,  carryover: -43900,  goalTarget: null },
      { groupId: g("Housing"), name: "Home Insurance",        sort: 4,  carryover: 0,       goalTarget: 240000 },
      { groupId: g("Housing"), name: "Home Maintenance",      sort: 5,  carryover: 0,       goalTarget: null },

      // Needs
      { groupId: g("Needs"), name: "Rent",                    sort: 0,  carryover: 0,       goalTarget: null },
      { groupId: g("Needs"), name: "Utilities, Electricity, Water", sort: 1, carryover: 0, goalTarget: null },
      { groupId: g("Needs"), name: "Internet, iPhone",        sort: 2,  carryover: 0,       goalTarget: null },
      { groupId: g("Needs"), name: "Household",               sort: 3,  carryover: -123118, goalTarget: null },
      { groupId: g("Needs"), name: "Groceries",               sort: 4,  carryover: 15965,   goalTarget: null },
      { groupId: g("Needs"), name: "Dental, Optical, Counselling", sort: 5, carryover: 0,   goalTarget: 400000 },
      { groupId: g("Needs"), name: "Public Transport, Uber, Bike", sort: 6, carryover: -1193, goalTarget: null },
      { groupId: g("Needs"), name: "Fees, Charges, Loans",    sort: 7,  carryover: -28447,  goalTarget: null },
      { groupId: g("Needs"), name: "Other Needs",             sort: 8,  carryover: 286884,  goalTarget: null },

      // Wants
      { groupId: g("Wants"), name: "Eat/Drink Out, Alcohol",  sort: 0,  carryover: -185485, goalTarget: null },
      { groupId: g("Wants"), name: "Sport, Exercise",         sort: 1,  carryover: 0,       goalTarget: null },
      { groupId: g("Wants"), name: "Lessons (Sailing, Guitar)", sort: 2, carryover: -71860, goalTarget: null },
      { groupId: g("Wants"), name: "Travels, Flights",        sort: 3,  carryover: 0,       goalTarget: null },
      { groupId: g("Wants"), name: "Car Rental, Petrol",      sort: 4,  carryover: -198581, goalTarget: null },
      { groupId: g("Wants"), name: "Computers, Games, Guitar",sort: 5,  carryover: 224611,  goalTarget: null },
      { groupId: g("Wants"), name: "Clothing",                sort: 6,  carryover: -45945,  goalTarget: null },
      { groupId: g("Wants"), name: "Work/Family",             sort: 7,  carryover: -362587, goalTarget: null },
      { groupId: g("Wants"), name: "Other Wants",             sort: 8,  carryover: 28099,   goalTarget: null },

      // Savings & Investments
      { groupId: g("Savings & Investments"), name: "Retirement",       sort: 0, carryover: 0,       goalTarget: null },
      { groupId: g("Savings & Investments"), name: "Manulife GRSP",    sort: 1, carryover: 21622,   goalTarget: null },
      { groupId: g("Savings & Investments"), name: "EquatePlus SAP",   sort: 2, carryover: -103654, goalTarget: null },
      { groupId: g("Savings & Investments"), name: "Other Investments", sort: 3, carryover: 0,      goalTarget: null },

      // Credit Card Payments
      { groupId: g("Credit Card Payments"), name: "AMEX Cobalt",           sort: 0, carryover: 389784, goalTarget: null, linkedAccountId: a("AMEX Cobalt") },
      { groupId: g("Credit Card Payments"), name: "Scotia Passport Visa",  sort: 1, carryover: 10348,  goalTarget: null, linkedAccountId: a("Scotia Passport Visa") },
      { groupId: g("Credit Card Payments"), name: "Rogers World Elite MC", sort: 2, carryover: 0,      goalTarget: null, linkedAccountId: a("Rogers World Elite MC") },
      { groupId: g("Credit Card Payments"), name: "Capital One Aspire MC", sort: 3, carryover: 0,      goalTarget: null, linkedAccountId: a("Capital One Aspire MC") },
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
  // ASSIGNMENTS (amounts in cents)
  // ---------------------------------------------------------------------------
  await db.insert(assignments).values([
    // Housing
    A("Mortgage Principal",         180000),
    A("Mortgage Interest",          235297),
    A("Property Taxes",             0),
    A("Condo Fees/HOA",             43900),
    A("Home Insurance",             0),
    A("Home Maintenance",           0),

    // Needs
    A("Rent",                       200000),
    A("Utilities, Electricity, Water", 15000),
    A("Internet, iPhone",           20000),
    A("Household",                  20000),
    A("Groceries",                  100000),
    A("Dental, Optical, Counselling", 40000),
    A("Public Transport, Uber, Bike", 7500),
    A("Fees, Charges, Loans",       3500),
    A("Other Needs",                5000),

    // Wants
    A("Eat/Drink Out, Alcohol",     100000),
    A("Sport, Exercise",            0),
    A("Lessons (Sailing, Guitar)",  0),
    A("Travels, Flights",           100000),
    A("Car Rental, Petrol",         0),
    A("Computers, Games, Guitar",   60000),
    A("Clothing",                   7560),
    A("Work/Family",                100000),
    A("Other Wants",                100000),

    // Savings & Investments
    A("Retirement",                 45550),
    A("Manulife GRSP",              0),
    A("EquatePlus SAP",             0),
    A("Other Investments",          0),
  ]);

  // ---------------------------------------------------------------------------
  // Helper to build a transaction record (amount in cents)
  // ---------------------------------------------------------------------------
  const T = (
    account: string,
    category: string | null,
    date: string,
    payee: string,
    amount: number,
    memo = "",
    status: "u" | "c" | "r" = "c",
    isIncome = false,
    transferAccount: string | null = null
  ) => ({
    accountId: a(account),
    categoryId: category ? byName(category) : null,
    date,
    payee,
    amount,
    memo,
    status,
    isIncome,
    transferAccountId: transferAccount ? a(transferAccount) : null,
  });

  // ---------------------------------------------------------------------------
  // TRANSACTIONS (amounts in cents)
  // ---------------------------------------------------------------------------
  await db.insert(transactions).values([
    // ── April 2026 ─────────────────────────────────────────────────────────
    T("EQ Bank", null, "2026-04-15", "SAP Concur", 442865, "Income for April", "c", true),
    T("EQ Bank", null, "2026-04-29", "SAP Concur", 442865, "Income for April", "c", true),
    T("TD Unlimited Chequing", "Mortgage Principal", "2026-04-01", "TD Bank", -180000, "Housing: Mortgage Principal", "r"),
    T("TD Unlimited Chequing", "Mortgage Interest",  "2026-04-01", "TD Bank", -235297, "Housing: Mortgage Interest", "r"),
    T("TD Unlimited Chequing", "Condo Fees/HOA", "2026-04-01", "Mountain's Edge MSP", -43900, "BC405", "r"),
    T("AMEX Cobalt", "Utilities, Electricity, Water", "2026-04-25", "Fortis BC", -30385, ""),
    T("AMEX Cobalt", "Groceries", "2026-04-05", "Superstore", -18742, ""),
    T("AMEX Cobalt", "Groceries", "2026-04-12", "Save-On-Foods", -14360, ""),
    T("AMEX Cobalt", "Groceries", "2026-04-19", "Costco",        -21233, "Split with Susie"),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-04-08", "Cactus Club",    -14200, "Split with Susie"),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-04-17", "Jam Café",       -5420,  ""),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-04-22", "Parallel 49 Brewing", -6740, "Split with Susie"),
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-04-10", "Telus", -11000, "", "r"),
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-04-10", "Fido",  -9000,  "", "r"),
    T("Susie", null, "2026-04-30", "Susie", 32015, "April shared expenses reimbursement", "c", true),

    // ── May 2026 ───────────────────────────────────────────────────────────
    T("EQ Bank", null, "2026-05-15", "SAP Concur", 442865, "Income for May", "c", true),
    T("EQ Bank", null, "2026-05-29", "SAP Concur", 442865, "Income for May", "c", true),
    T("TD Unlimited Chequing", "Mortgage Principal", "2026-05-01", "TD Bank", -180000, "Housing: Mortgage Principal"),
    T("TD Unlimited Chequing", "Mortgage Interest",  "2026-05-01", "TD Bank", -235297, "Housing: Mortgage Interest"),
    T("TD Unlimited Chequing", "Condo Fees/HOA", "2026-05-01", "Mountain's Edge MSP", -43900, "BC405"),
    T("AMEX Cobalt", "Groceries", "2026-05-06", "Superstore",   -19655, ""),
    T("AMEX Cobalt", "Groceries", "2026-05-14", "Save-On-Foods",-13820, ""),
    T("AMEX Cobalt", "Groceries", "2026-05-21", "T&T Supermarket",-8935,""),
    T("AMEX Cobalt", "Groceries", "2026-05-28", "Costco",       -24578, "Split with Susie"),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-05-10", "Miku Restaurant",  -21840, "Split with Susie"),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-05-16", "Tacofino",         -5890,  ""),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-05-23", "Browns Social House",-9730,"Split with Susie"),
    T("AMEX Cobalt", "Utilities, Electricity, Water", "2026-05-25", "Fortis BC", -28129, ""),
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-05-10", "Telus", -11000, ""),
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-05-10", "Fido",  -9000,  ""),
    T("AMEX Cobalt", "Household", "2026-05-12", "Home Depot",  -9471,  ""),
    T("AMEX Cobalt", "Household", "2026-05-20", "Ikea",        -16350, "Split with Susie"),
    T("TD Unlimited Chequing", "Lessons (Sailing, Guitar)", "2026-05-01", "Jericho Sailing Centre", -71860, "Annual membership"),
    T("AMEX Cobalt", "Public Transport, Uber, Bike", "2026-05-18", "Uber", -3193, ""),
    T("Susie", null, "2026-05-31", "Susie", 35040, "May shared expenses reimbursement", "c", true),
    T("TD Unlimited Chequing", null, "2026-05-20", "AMEX Payment", -353105, "Card payment", "c", false, "AMEX Cobalt"),

    // ── June 2026 (DEMO_MONTH) ─────────────────────────────────────────────
    T("EQ Bank", null, "2026-06-16", "SAP Concur", 415297, "Income for June", "c", true),
    T("EQ Bank", null, "2026-06-30", "SAP Concur", 415297, "Income for June", "c", true),
    T("EQ Bank", null, "2026-06-09", "TD Bank",   50000, "bonus", "c", true),
    // Transfer EQ → TD for mortgage
    T("EQ Bank", null, "2026-06-01", "Transfer: TD Unlimited Chequing", -415297, "", "c", false, "TD Unlimited Chequing"),
    // Mortgage split: principal + interest
    T("TD Unlimited Chequing", "Mortgage Principal", "2026-06-01", "TD Bank", -180000, "Housing: Mortgage Principal"),
    T("TD Unlimited Chequing", "Mortgage Interest",  "2026-06-01", "TD Bank", -235297, "Housing: Mortgage Interest"),
    // Condo fees
    T("TD Unlimited Chequing", "Condo Fees/HOA", "2026-06-02", "Mountain's Edge MSP", -43900, "BC405"),
    // Internet / phone
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-06-10", "Telus", -11000, ""),
    T("TD Unlimited Chequing", "Internet, iPhone", "2026-06-10", "Fido",  -9000,  ""),
    // Utilities — Fortis BC
    T("AMEX Cobalt", "Utilities, Electricity, Water", "2026-06-25", "Fortis BC", -30385, ""),
    // Groceries
    T("AMEX Cobalt", "Groceries", "2026-06-04", "Superstore",    -20318, ""),
    T("AMEX Cobalt", "Groceries", "2026-06-11", "Save-On-Foods", -15542, ""),
    T("AMEX Cobalt", "Groceries", "2026-06-18", "T&T Supermarket",-9374,""),
    T("AMEX Cobalt", "Groceries", "2026-06-25", "Costco",        -22906, "Split with Susie"),
    // Dining / drinks
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-06-07", "Published on Main",   -17850, "Split with Susie"),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-06-13", "St. Augustine's Pub", -8730,  "Split with Susie"),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-06-20", "Nemesis Coffee",      -4215,  ""),
    T("AMEX Cobalt", "Eat/Drink Out, Alcohol", "2026-06-26", "Boulevard Kitchen",   -20480, ""),
    // Household
    T("AMEX Cobalt", "Household", "2026-06-08", "Home Depot",    -7342,  ""),
    // Transport
    T("AMEX Cobalt", "Public Transport, Uber, Bike", "2026-06-14", "Uber",    -2350, ""),
    T("AMEX Cobalt", "Public Transport, Uber, Bike", "2026-06-22", "TransLink", -10000, "3-month pass"),
    // Clothing
    T("AMEX Cobalt", "Clothing", "2026-06-15", "Aritzia",        -18900, ""),
    // Travel savings
    T("EQ Bank", "Travels, Flights", "2026-06-01", "Air Canada",  -120000, "Flights to Europe"),
    // Computers
    T("AMEX Cobalt", "Computers, Games, Guitar", "2026-06-03", "Apple Store", -40954, "iPad keyboard"),
    // Dental
    T("TD Unlimited Chequing", "Dental, Optical, Counselling", "2026-06-18", "Dr. Smith Dental", -28523, ""),
    // Work/Family
    T("AMEX Cobalt", "Work/Family", "2026-06-12", "Amazon", -14792, ""),
    T("AMEX Cobalt", "Work/Family", "2026-06-19", "Indigo Books", -5835, ""),
    // Retirement / savings transfer
    T("EQ Bank", null, "2026-06-01", "Wealthsimple TFSA", -45550, "Monthly TFSA contribution", "c", false, "Wealthsimple TFSA"),
    // Susie shared expense tracking
    T("Susie", null, "2026-06-07", "Published on Main (Susie share)",    -8925,  "Half of dinner"),
    T("Susie", null, "2026-06-13", "St. Augustine's (Susie share)",      -4365,  "Half of pub tab"),
    T("Susie", null, "2026-06-25", "Costco groceries (Susie share)",     -11453, "Half of Costco run"),
    // AMEX payment from TD
    T("TD Unlimited Chequing", null, "2026-06-20", "AMEX Payment", -415297, "Card payment", "c", false, "AMEX Cobalt"),
    // Fees
    T("TD Unlimited Chequing", "Fees, Charges, Loans", "2026-06-30", "TD Bank", -1795, "Monthly bank fee"),
  ]);

  // TD last reconciled metadata
  await db
    .update(accounts)
    .set({ lastReconciledAt: "2026-04-10", lastReconciledBalance: 608358 })
    .where(eq(accounts.name, "TD Unlimited Chequing"));

  // ---------------------------------------------------------------------------
  // RECURRING (amounts in cents)
  // ---------------------------------------------------------------------------
  await db.insert(recurring).values([
    // Mortgage — monthly on the 1st
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Mortgage Principal"), payee: "TD Bank", amount: -180000,    frequency: "monthly", nextDate: "2026-07-01", active: true },
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Mortgage Interest"),  payee: "TD Bank", amount: -235297,    frequency: "monthly", nextDate: "2026-07-01", active: true },
    // Condo fees
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Condo Fees/HOA"),     payee: "Mountain's Edge MSP", amount: -43900, frequency: "monthly", nextDate: "2026-07-01", active: true },
    // Internet & phone
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Internet, iPhone"),   payee: "Telus",  amount: -11000, frequency: "monthly", nextDate: "2026-07-10", active: true },
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Internet, iPhone"),   payee: "Fido",   amount: -9000,  frequency: "monthly", nextDate: "2026-07-10", active: true },
    // Utilities (estimated)
    { accountId: a("AMEX Cobalt"),           categoryId: byName("Utilities, Electricity, Water"), payee: "Fortis BC", amount: -30000, frequency: "monthly", nextDate: "2026-07-25", active: true },
    // Payroll — biweekly (represented as two monthly entries)
    { accountId: a("EQ Bank"), categoryId: null, payee: "SAP Concur", amount: 415297, frequency: "monthly", nextDate: "2026-07-16", active: true },
    { accountId: a("EQ Bank"), categoryId: null, payee: "SAP Concur", amount: 415297, frequency: "monthly", nextDate: "2026-07-30", active: true },
    // TFSA contribution
    { accountId: a("EQ Bank"), categoryId: null, payee: "Wealthsimple TFSA", amount: -45550, frequency: "monthly", nextDate: "2026-07-01", active: true, transferAccountId: a("Wealthsimple TFSA") },
    // Jericho sailing — annual (next year)
    { accountId: a("TD Unlimited Chequing"), categoryId: byName("Lessons (Sailing, Guitar)"), payee: "Jericho Sailing Centre", amount: -71860, frequency: "yearly", nextDate: "2027-05-01", active: true },
  ]);
  db.run(sql`COMMIT`);
} catch (err) {
  db.run(sql`ROLLBACK`);
  throw err;
}
}
