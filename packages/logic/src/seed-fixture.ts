import type { Account, Assignment, BudgetData, Category, CategoryGroup, Recurring, RecurringSubTransaction, Transaction } from "./types.js";

// Demo month: June 2026 — matches the highlighted month in the YNAB4 screenshots.
export const DEMO_MONTH = "2026-06";

// ---------------------------------------------------------------------------
// ACCOUNTS
// ---------------------------------------------------------------------------
const accounts: Account[] = [
  // On-budget: liquid
  { id: 1,  name: "TD Unlimited Chequing", kind: "liquid",    groupLabel: "Budget Accounts", balance: "10875.55",   onBudget: true,  sort: 0 },
  { id: 2,  name: "EQ Bank",               kind: "liquid",    groupLabel: "Budget Accounts", balance: "103830.79",  onBudget: true,  sort: 1 },
  { id: 3,  name: "Scotia e-Chequing",     kind: "liquid",    groupLabel: "Budget Accounts", balance: "458.23",     onBudget: true,  sort: 2 },
  { id: 4,  name: "Cash",                  kind: "liquid",    groupLabel: "Budget Accounts", balance: "116.05",     onBudget: true,  sort: 3 },
  // On-budget: credit cards
  { id: 5,  name: "AMEX Cobalt",           kind: "credit",    groupLabel: "Credit Cards",    balance: "-3897.84",   onBudget: true,  sort: 4 },
  { id: 6,  name: "Scotia Passport Visa",  kind: "credit",    groupLabel: "Credit Cards",    balance: "-103.48",    onBudget: true,  sort: 5 },
  { id: 7,  name: "Rogers World Elite MC", kind: "credit",    groupLabel: "Credit Cards",    balance: "0.00",       onBudget: true,  sort: 6 },
  { id: 8,  name: "Capital One Aspire MC", kind: "credit",    groupLabel: "Credit Cards",    balance: "0.00",       onBudget: true,  sort: 7 },
  // Tracking (reimbursement)
  { id: 9,  name: "Susie",                 kind: "liquid",    groupLabel: "Tracking",        balance: "-674.28",    onBudget: true,  sort: 8 },
  { id: 10, name: "Parents",               kind: "liquid",    groupLabel: "Tracking",        balance: "3735.35",    onBudget: true,  sort: 9 },
  // Off-budget: investments
  { id: 11, name: "Wealthsimple Trade",    kind: "offbudget", groupLabel: "Investments",     balance: "0.00",       onBudget: false, sort: 10 },
  { id: 12, name: "Wealthsimple TFSA",     kind: "offbudget", groupLabel: "Investments",     balance: "153674.37",  onBudget: false, sort: 11 },
  { id: 13, name: "Wealthsimple RRSP",     kind: "offbudget", groupLabel: "Investments",     balance: "196700.22",  onBudget: false, sort: 12 },
  { id: 14, name: "Manulife GRSP",         kind: "offbudget", groupLabel: "Investments",     balance: "99213.86",   onBudget: false, sort: 13 },
  { id: 15, name: "EquatePlus SAP",        kind: "offbudget", groupLabel: "Investments",     balance: "2357.41",    onBudget: false, sort: 14 },
  { id: 16, name: "British Airways Credit",kind: "offbudget", groupLabel: "Investments",     balance: "357.00",     onBudget: false, sort: 15 },
  // Off-budget: property
  { id: 17, name: "Home Value",            kind: "offbudget", groupLabel: "Property",        balance: "979000.00",  onBudget: false, sort: 16 },
  { id: 18, name: "Mortgage Debt",         kind: "offbudget", groupLabel: "Property",        balance: "-660253.55", onBudget: false, sort: 17 },
];

// ---------------------------------------------------------------------------
// CATEGORY GROUPS
// ---------------------------------------------------------------------------
const groups: CategoryGroup[] = [
  { id: 1, name: "Housing",               sort: 0, isCreditCardPayments: false },
  { id: 2, name: "Needs",                 sort: 1, isCreditCardPayments: false },
  { id: 3, name: "Wants",                 sort: 2, isCreditCardPayments: false },
  { id: 4, name: "Savings & Investments", sort: 3, isCreditCardPayments: false },
  { id: 5, name: "Credit Card Payments",  sort: 4, isCreditCardPayments: true  },
];

// ---------------------------------------------------------------------------
// CATEGORIES
// ---------------------------------------------------------------------------
const categories: Category[] = [
  // Housing
  { id: 1,  groupId: 1, name: "Mortgage Principal",             sort: 0, carryover: "0.00",      goalTarget: null,       linkedAccountId: null },
  { id: 2,  groupId: 1, name: "Mortgage Interest",              sort: 1, carryover: "0.00",      goalTarget: null,       linkedAccountId: null },
  { id: 3,  groupId: 1, name: "Property Taxes",                 sort: 2, carryover: "0.00",      goalTarget: "8400.00",  linkedAccountId: null },
  { id: 4,  groupId: 1, name: "Condo Fees/HOA",                 sort: 3, carryover: "-439.00",   goalTarget: null,       linkedAccountId: null },
  { id: 5,  groupId: 1, name: "Home Insurance",                 sort: 4, carryover: "0.00",      goalTarget: "2400.00",  linkedAccountId: null },
  { id: 6,  groupId: 1, name: "Home Maintenance",               sort: 5, carryover: "0.00",      goalTarget: null,       linkedAccountId: null },

  // Needs
  { id: 7,  groupId: 2, name: "Rent",                           sort: 0, carryover: "0.00",      goalTarget: null,       linkedAccountId: null },
  { id: 8,  groupId: 2, name: "Utilities, Electricity, Water",  sort: 1, carryover: "0.00",      goalTarget: null,       linkedAccountId: null },
  { id: 9,  groupId: 2, name: "Internet, iPhone",               sort: 2, carryover: "0.00",      goalTarget: null,       linkedAccountId: null },
  { id: 10, groupId: 2, name: "Household",                      sort: 3, carryover: "-1231.18",  goalTarget: null,       linkedAccountId: null },
  { id: 11, groupId: 2, name: "Groceries",                      sort: 4, carryover: "159.65",    goalTarget: null,       linkedAccountId: null },
  { id: 12, groupId: 2, name: "Dental, Optical, Counselling",   sort: 5, carryover: "0.00",      goalTarget: "4000.00",  linkedAccountId: null },
  { id: 13, groupId: 2, name: "Public Transport, Uber, Bike",   sort: 6, carryover: "-11.93",    goalTarget: null,       linkedAccountId: null },
  { id: 14, groupId: 2, name: "Fees, Charges, Loans",           sort: 7, carryover: "-284.47",   goalTarget: null,       linkedAccountId: null },
  { id: 15, groupId: 2, name: "Other Needs",                    sort: 8, carryover: "2868.84",   goalTarget: null,       linkedAccountId: null },

  // Wants
  { id: 16, groupId: 3, name: "Eat/Drink Out, Alcohol",         sort: 0, carryover: "-1854.85",  goalTarget: null,       linkedAccountId: null },
  { id: 17, groupId: 3, name: "Sport, Exercise",                sort: 1, carryover: "0.00",      goalTarget: null,       linkedAccountId: null },
  { id: 18, groupId: 3, name: "Lessons (Sailing, Guitar)",      sort: 2, carryover: "-718.60",   goalTarget: null,       linkedAccountId: null },
  { id: 19, groupId: 3, name: "Travels, Flights",               sort: 3, carryover: "0.00",      goalTarget: null,       linkedAccountId: null },
  { id: 20, groupId: 3, name: "Car Rental, Petrol",             sort: 4, carryover: "-1985.81",  goalTarget: null,       linkedAccountId: null },
  { id: 21, groupId: 3, name: "Computers, Games, Guitar",       sort: 5, carryover: "2246.11",   goalTarget: null,       linkedAccountId: null },
  { id: 22, groupId: 3, name: "Clothing",                       sort: 6, carryover: "-459.45",   goalTarget: null,       linkedAccountId: null },
  { id: 23, groupId: 3, name: "Work/Family",                    sort: 7, carryover: "-3625.87",  goalTarget: null,       linkedAccountId: null },
  { id: 24, groupId: 3, name: "Other Wants",                    sort: 8, carryover: "280.99",    goalTarget: null,       linkedAccountId: null },

  // Savings & Investments
  { id: 25, groupId: 4, name: "Retirement",                     sort: 0, carryover: "0.00",      goalTarget: null,       linkedAccountId: null },
  { id: 26, groupId: 4, name: "Manulife GRSP",                  sort: 1, carryover: "216.22",    goalTarget: null,       linkedAccountId: null },
  { id: 27, groupId: 4, name: "EquatePlus SAP",                 sort: 2, carryover: "-1036.54",  goalTarget: null,       linkedAccountId: null },
  { id: 28, groupId: 4, name: "Other Investments",              sort: 3, carryover: "0.00",      goalTarget: null,       linkedAccountId: null },

  // Credit Card Payments (linked to CC accounts)
  { id: 29, groupId: 5, name: "AMEX Cobalt",           sort: 0, carryover: "3897.84", goalTarget: null, linkedAccountId: 5 },
  { id: 30, groupId: 5, name: "Scotia Passport Visa",  sort: 1, carryover: "103.48",  goalTarget: null, linkedAccountId: 6 },
  { id: 31, groupId: 5, name: "Rogers World Elite MC", sort: 2, carryover: "0.00",    goalTarget: null, linkedAccountId: 7 },
  { id: 32, groupId: 5, name: "Capital One Aspire MC", sort: 3, carryover: "0.00",    goalTarget: null, linkedAccountId: 8 },
];

// ---------------------------------------------------------------------------
// HELPER: find category id by name
// ---------------------------------------------------------------------------
const cid = (name: string): number => {
  const c = categories.find((c) => c.name === name);
  if (!c) throw new Error(`unknown category: ${name}`);
  return c.id;
};

// ---------------------------------------------------------------------------
// ASSIGNMENTS — budgeted amounts for June 2026 (DEMO_MONTH)
// ---------------------------------------------------------------------------
const assignments: Assignment[] = [
  // Housing
  { id:  1, categoryId: cid("Mortgage Principal"),           month: DEMO_MONTH, amount: "1800.00"  },
  { id:  2, categoryId: cid("Mortgage Interest"),            month: DEMO_MONTH, amount: "2352.97"  },
  { id:  3, categoryId: cid("Property Taxes"),               month: DEMO_MONTH, amount: "0.00"     },
  { id:  4, categoryId: cid("Condo Fees/HOA"),               month: DEMO_MONTH, amount: "439.00"   },
  { id:  5, categoryId: cid("Home Insurance"),               month: DEMO_MONTH, amount: "0.00"     },
  { id:  6, categoryId: cid("Home Maintenance"),             month: DEMO_MONTH, amount: "0.00"     },
  // Needs
  { id:  7, categoryId: cid("Rent"),                         month: DEMO_MONTH, amount: "2000.00"  },
  { id:  8, categoryId: cid("Utilities, Electricity, Water"),month: DEMO_MONTH, amount: "150.00"   },
  { id:  9, categoryId: cid("Internet, iPhone"),             month: DEMO_MONTH, amount: "200.00"   },
  { id: 10, categoryId: cid("Household"),                    month: DEMO_MONTH, amount: "200.00"   },
  { id: 11, categoryId: cid("Groceries"),                    month: DEMO_MONTH, amount: "1000.00"  },
  { id: 12, categoryId: cid("Dental, Optical, Counselling"), month: DEMO_MONTH, amount: "400.00"   },
  { id: 13, categoryId: cid("Public Transport, Uber, Bike"), month: DEMO_MONTH, amount: "75.00"    },
  { id: 14, categoryId: cid("Fees, Charges, Loans"),         month: DEMO_MONTH, amount: "35.00"    },
  { id: 15, categoryId: cid("Other Needs"),                  month: DEMO_MONTH, amount: "50.00"    },
  // Wants
  { id: 16, categoryId: cid("Eat/Drink Out, Alcohol"),       month: DEMO_MONTH, amount: "1000.00"  },
  { id: 17, categoryId: cid("Sport, Exercise"),              month: DEMO_MONTH, amount: "0.00"     },
  { id: 18, categoryId: cid("Lessons (Sailing, Guitar)"),    month: DEMO_MONTH, amount: "0.00"     },
  { id: 19, categoryId: cid("Travels, Flights"),             month: DEMO_MONTH, amount: "1000.00"  },
  { id: 20, categoryId: cid("Car Rental, Petrol"),           month: DEMO_MONTH, amount: "0.00"     },
  { id: 21, categoryId: cid("Computers, Games, Guitar"),     month: DEMO_MONTH, amount: "600.00"   },
  { id: 22, categoryId: cid("Clothing"),                     month: DEMO_MONTH, amount: "75.60"    },
  { id: 23, categoryId: cid("Work/Family"),                  month: DEMO_MONTH, amount: "1000.00"  },
  { id: 24, categoryId: cid("Other Wants"),                  month: DEMO_MONTH, amount: "1000.00"  },
  // Savings
  { id: 25, categoryId: cid("Retirement"),                   month: DEMO_MONTH, amount: "455.50"   },
  { id: 26, categoryId: cid("Manulife GRSP"),                month: DEMO_MONTH, amount: "0.00"     },
  { id: 27, categoryId: cid("EquatePlus SAP"),               month: DEMO_MONTH, amount: "0.00"     },
  { id: 28, categoryId: cid("Other Investments"),            month: DEMO_MONTH, amount: "0.00"     },

  // ── May 2026 assignments (prior month for carryover math) ─────────────────
  { id: 29, categoryId: cid("Mortgage Principal"),           month: "2026-05", amount: "1800.00"  },
  { id: 30, categoryId: cid("Mortgage Interest"),            month: "2026-05", amount: "2352.97"  },
  { id: 31, categoryId: cid("Condo Fees/HOA"),               month: "2026-05", amount: "439.00"   },
  { id: 32, categoryId: cid("Internet, iPhone"),             month: "2026-05", amount: "200.00"   },
  { id: 33, categoryId: cid("Utilities, Electricity, Water"),month: "2026-05", amount: "150.00"   },
  { id: 34, categoryId: cid("Groceries"),                    month: "2026-05", amount: "1000.00"  },
  { id: 35, categoryId: cid("Household"),                    month: "2026-05", amount: "200.00"   },
  { id: 36, categoryId: cid("Eat/Drink Out, Alcohol"),       month: "2026-05", amount: "1000.00"  },
  { id: 37, categoryId: cid("Public Transport, Uber, Bike"), month: "2026-05", amount: "75.00"    },
  { id: 38, categoryId: cid("Retirement"),                   month: "2026-05", amount: "455.50"   },
  { id: 39, categoryId: cid("Rent"),                         month: "2026-05", amount: "2000.00"  },
  { id: 40, categoryId: cid("Dental, Optical, Counselling"), month: "2026-05", amount: "400.00"   },
  { id: 41, categoryId: cid("Fees, Charges, Loans"),         month: "2026-05", amount: "35.00"    },
  { id: 42, categoryId: cid("Lessons (Sailing, Guitar)"),    month: "2026-05", amount: "718.60"   },
  { id: 43, categoryId: cid("Travels, Flights"),             month: "2026-05", amount: "1000.00"  },
  { id: 44, categoryId: cid("Computers, Games, Guitar"),     month: "2026-05", amount: "600.00"   },
  { id: 45, categoryId: cid("Work/Family"),                  month: "2026-05", amount: "1000.00"  },
  { id: 46, categoryId: cid("Other Wants"),                  month: "2026-05", amount: "1000.00"  },
  { id: 47, categoryId: cid("Other Needs"),                  month: "2026-05", amount: "50.00"    },
  { id: 48, categoryId: cid("Clothing"),                     month: "2026-05", amount: "75.60"    },
];

// ---------------------------------------------------------------------------
// TRANSACTIONS — April, May & June 2026
// ---------------------------------------------------------------------------
let _tid = 1;
const T = (
  accountId: number,
  categoryId: number | null,
  date: string,
  payee: string,
  amount: string,
  memo = "",
  status: "u" | "c" | "r" = "c"
): Transaction => ({
  id: _tid++,
  accountId,
  categoryId,
  date,
  payee,
  amount,
  memo,
  status,
});

// Account IDs by name (must match accounts array above)
const _aidMap: Record<string, number> = {
  "TD Unlimited Chequing": 1,
  "EQ Bank":               2,
  "Scotia e-Chequing":     3,
  "Cash":                  4,
  "AMEX Cobalt":           5,
  "Scotia Passport Visa":  6,
  "Rogers World Elite MC": 7,
  "Capital One Aspire MC": 8,
  "Susie":                 9,
  "Parents":               10,
};

const aid = (name: string): number => {
  const id = _aidMap[name];
  if (id == null) throw new Error(`unknown account in fixture: ${name}`);
  return id;
};

const transactions: Transaction[] = [
  // ── April 2026 ────────────────────────────────────────────────────────────
  T(aid("EQ Bank"),               null,                         "2026-04-15", "SAP Concur",               "4428.65",  "Income for April"),
  T(aid("EQ Bank"),               null,                         "2026-04-29", "SAP Concur",               "4428.65",  "Income for April"),
  T(aid("TD Unlimited Chequing"), cid("Mortgage Principal"),    "2026-04-01", "TD Bank",                  "-1800.00", "Housing: Mortgage Principal"),
  T(aid("TD Unlimited Chequing"), cid("Mortgage Interest"),     "2026-04-01", "TD Bank",                  "-2352.97", "Housing: Mortgage Interest"),
  T(aid("TD Unlimited Chequing"), cid("Condo Fees/HOA"),        "2026-04-01", "Mountain's Edge MSP",      "-439.00",  "BC405"),
  T(aid("AMEX Cobalt"),           cid("Utilities, Electricity, Water"), "2026-04-25", "Fortis BC",        "-303.85",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-04-05", "Superstore",               "-187.42",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-04-12", "Save-On-Foods",            "-143.60",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-04-19", "Costco",                   "-212.33",  "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-04-08", "Cactus Club",              "-142.00",  "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-04-17", "Jam Café",                 "-54.20",   ""),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-04-22", "Parallel 49 Brewing",      "-67.40",   "Split with Susie"),
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-04-10", "Telus",                    "-110.00",  ""),
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-04-10", "Fido",                     "-90.00",   ""),
  T(aid("Susie"),                 null,                         "2026-04-30", "Susie",                    "320.15",   "April shared expenses reimbursement"),

  // ── May 2026 ──────────────────────────────────────────────────────────────
  T(aid("EQ Bank"),               null,                         "2026-05-15", "SAP Concur",               "4428.65",  "Income for May"),
  T(aid("EQ Bank"),               null,                         "2026-05-29", "SAP Concur",               "4428.65",  "Income for May"),
  T(aid("TD Unlimited Chequing"), cid("Mortgage Principal"),    "2026-05-01", "TD Bank",                  "-1800.00", "Housing: Mortgage Principal"),
  T(aid("TD Unlimited Chequing"), cid("Mortgage Interest"),     "2026-05-01", "TD Bank",                  "-2352.97", "Housing: Mortgage Interest"),
  T(aid("TD Unlimited Chequing"), cid("Condo Fees/HOA"),        "2026-05-01", "Mountain's Edge MSP",      "-439.00",  "BC405"),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-05-06", "Superstore",               "-196.55",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-05-14", "Save-On-Foods",            "-138.20",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-05-21", "T&T Supermarket",          "-89.35",   ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-05-28", "Costco",                   "-245.78",  "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-05-10", "Miku Restaurant",          "-218.40",  "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-05-16", "Tacofino",                 "-58.90",   ""),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-05-23", "Browns Social House",      "-97.30",   "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Utilities, Electricity, Water"), "2026-05-25", "Fortis BC",        "-281.29",  ""),
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-05-10", "Telus",                    "-110.00",  ""),
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-05-10", "Fido",                     "-90.00",   ""),
  T(aid("AMEX Cobalt"),           cid("Household"),             "2026-05-12", "Home Depot",               "-94.71",   ""),
  T(aid("AMEX Cobalt"),           cid("Household"),             "2026-05-20", "Ikea",                     "-163.50",  "Split with Susie"),
  T(aid("TD Unlimited Chequing"), cid("Lessons (Sailing, Guitar)"), "2026-05-01", "Jericho Sailing Centre","-718.60", "Annual membership"),
  T(aid("AMEX Cobalt"),           cid("Public Transport, Uber, Bike"), "2026-05-18", "Uber",             "-31.93",   ""),
  T(aid("Susie"),                 null,                         "2026-05-31", "Susie",                    "350.40",   "May shared expenses reimbursement"),
  T(aid("TD Unlimited Chequing"), cid("AMEX Cobalt"),           "2026-05-20", "AMEX Payment",             "-3531.05", "Card payment"),

  // ── June 2026 (DEMO_MONTH) ─────────────────────────────────────────────────
  T(aid("EQ Bank"),               null,                         "2026-06-16", "SAP Concur",               "4152.97",  "Income for June"),
  T(aid("EQ Bank"),               null,                         "2026-06-30", "SAP Concur",               "4152.97",  "Income for June"),
  T(aid("EQ Bank"),               null,                         "2026-06-09", "TD Bank",                  "500.00",   "bonus"),
  // Transfer EQ → TD to cover mortgage
  T(aid("EQ Bank"),               null,                         "2026-06-01", "Transfer: TD Unlimited Chequing", "-4152.97", ""),
  T(aid("TD Unlimited Chequing"), null,                         "2026-06-01", "Transfer: EQ Bank",         "4152.97",  ""),
  // Mortgage
  T(aid("TD Unlimited Chequing"), cid("Mortgage Principal"),    "2026-06-01", "TD Bank",                  "-1800.00", "Housing: Mortgage Principal"),
  T(aid("TD Unlimited Chequing"), cid("Mortgage Interest"),     "2026-06-01", "TD Bank",                  "-2352.97", "Housing: Mortgage Interest"),
  // Condo
  T(aid("TD Unlimited Chequing"), cid("Condo Fees/HOA"),        "2026-06-02", "Mountain's Edge MSP",      "-439.00",  "BC405"),
  // Phone / internet
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-06-10", "Telus",                    "-110.00",  ""),
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-06-10", "Fido",                     "-90.00",   ""),
  // Utilities
  T(aid("AMEX Cobalt"),           cid("Utilities, Electricity, Water"), "2026-06-25", "Fortis BC",        "-303.85",  ""),
  // Groceries
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-06-04", "Superstore",               "-203.18",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-06-11", "Save-On-Foods",            "-155.42",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-06-18", "T&T Supermarket",          "-93.74",   ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-06-25", "Costco",                   "-229.06",  "Split with Susie"),
  // Dining / drinks
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-06-07", "Published on Main",        "-178.50",  "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-06-13", "St. Augustine's Pub",      "-87.30",   "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-06-20", "Nemesis Coffee",           "-42.15",   ""),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-06-26", "Boulevard Kitchen",        "-204.80",  ""),
  // Household
  T(aid("AMEX Cobalt"),           cid("Household"),             "2026-06-08", "Home Depot",               "-73.42",   ""),
  // Transport
  T(aid("AMEX Cobalt"),           cid("Public Transport, Uber, Bike"), "2026-06-14", "Uber",             "-23.50",   ""),
  T(aid("AMEX Cobalt"),           cid("Public Transport, Uber, Bike"), "2026-06-22", "TransLink",        "-100.00",  "3-month pass"),
  // Clothing
  T(aid("AMEX Cobalt"),           cid("Clothing"),              "2026-06-15", "Aritzia",                  "-189.00",  ""),
  // Travel
  T(aid("EQ Bank"),               cid("Travels, Flights"),      "2026-06-01", "Air Canada",               "-1200.00", "Flights to Europe"),
  // Computers / tech
  T(aid("AMEX Cobalt"),           cid("Computers, Games, Guitar"),"2026-06-03","Apple Store",             "-409.54",  "iPad keyboard"),
  // Dental
  T(aid("TD Unlimited Chequing"), cid("Dental, Optical, Counselling"), "2026-06-18", "Dr. Smith Dental", "-285.23",  ""),
  // Work/Family
  T(aid("AMEX Cobalt"),           cid("Work/Family"),           "2026-06-12", "Amazon",                   "-147.92",  ""),
  T(aid("AMEX Cobalt"),           cid("Work/Family"),           "2026-06-19", "Indigo Books",             "-58.35",   ""),
  // TFSA contribution
  T(aid("EQ Bank"),               cid("Retirement"),            "2026-06-01", "Wealthsimple TFSA",        "-455.50",  "Monthly TFSA contribution"),
  // Susie shared expense split tracking
  T(aid("Susie"),                 null,                         "2026-06-07", "Published on Main (Susie share)", "-89.25",  "Half of dinner"),
  T(aid("Susie"),                 null,                         "2026-06-13", "St. Augustine's (Susie share)",  "-43.65",  "Half of pub tab"),
  T(aid("Susie"),                 null,                         "2026-06-25", "Costco groceries (Susie share)", "-114.53", "Half of Costco run"),
  // AMEX payment from TD
  T(aid("TD Unlimited Chequing"), cid("AMEX Cobalt"),           "2026-06-20", "AMEX Payment",             "-4152.97", "Card payment"),
  // Bank fee
  T(aid("TD Unlimited Chequing"), cid("Fees, Charges, Loans"),  "2026-06-30", "TD Bank",                  "-17.95",   "Monthly bank fee"),
];

// ---------------------------------------------------------------------------
// RECURRING — scheduled transactions next firing in 2026-07
// ---------------------------------------------------------------------------
const recurring: (Recurring & { subTransactions: RecurringSubTransaction[] })[] = [
  // Mortgage
  { id: 1,  accountId: aid("TD Unlimited Chequing"), categoryId: cid("Mortgage Principal"),            payee: "TD Bank",                  amount: "-1800.00",    frequency: "monthly", nextDate: "2026-07-01", active: true, subTransactions: [] },
  { id: 2,  accountId: aid("TD Unlimited Chequing"), categoryId: cid("Mortgage Interest"),             payee: "TD Bank",                  amount: "-2352.97",    frequency: "monthly", nextDate: "2026-07-01", active: true, subTransactions: [] },
  // Condo
  { id: 3,  accountId: aid("TD Unlimited Chequing"), categoryId: cid("Condo Fees/HOA"),                payee: "Mountain's Edge MSP",       amount: "-439.00",     frequency: "monthly", nextDate: "2026-07-01", active: true, subTransactions: [] },
  // Internet / phone
  { id: 4,  accountId: aid("TD Unlimited Chequing"), categoryId: cid("Internet, iPhone"),              payee: "Telus",                     amount: "-110.00",     frequency: "monthly", nextDate: "2026-07-10", active: true, subTransactions: [] },
  { id: 5,  accountId: aid("TD Unlimited Chequing"), categoryId: cid("Internet, iPhone"),              payee: "Fido",                      amount: "-90.00",      frequency: "monthly", nextDate: "2026-07-10", active: true, subTransactions: [] },
  // Utilities
  { id: 6,  accountId: aid("AMEX Cobalt"),           categoryId: cid("Utilities, Electricity, Water"), payee: "Fortis BC",                 amount: "-300.00",     frequency: "monthly", nextDate: "2026-07-25", active: true, subTransactions: [] },
  // Payroll — biweekly (two entries)
  { id: 7,  accountId: aid("EQ Bank"),               categoryId: null,                                 payee: "SAP Concur",                amount: "4152.97",     frequency: "monthly", nextDate: "2026-07-16", active: true, subTransactions: [] },
  { id: 8,  accountId: aid("EQ Bank"),               categoryId: null,                                 payee: "SAP Concur",                amount: "4152.97",     frequency: "monthly", nextDate: "2026-07-30", active: true, subTransactions: [] },
  // TFSA contribution
  { id: 9,  accountId: aid("EQ Bank"),               categoryId: cid("Retirement"),                    payee: "Wealthsimple TFSA",         amount: "-455.50",     frequency: "monthly", nextDate: "2026-07-01", active: true, subTransactions: [] },
  // Sailing (annual)
  { id: 10, accountId: aid("TD Unlimited Chequing"), categoryId: cid("Lessons (Sailing, Guitar)"),     payee: "Jericho Sailing Centre",    amount: "-718.60",     frequency: "yearly",  nextDate: "2027-05-01", active: true, subTransactions: [] },
];

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export function makeSeedBudgetData(): BudgetData {
  return { accounts, groups, categories, assignments, transactions, recurring };
}
