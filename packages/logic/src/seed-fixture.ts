import type { Account, Assignment, BudgetData, Category, CategoryGroup, Recurring, RecurringSubTransaction, Transaction } from "./types.js";

// Demo month: June 2026 — matches the highlighted month in the YNAB4 screenshots.
export const DEMO_MONTH = "2026-06";

// ---------------------------------------------------------------------------
// ACCOUNTS
// ---------------------------------------------------------------------------
const accounts: Account[] = [
  // On-budget: liquid
  { id: 1,  name: "TD Unlimited Chequing", kind: "liquid",    groupLabel: "Budget Accounts", balance: "1087555",   onBudget: true,  sort: 0 },
  { id: 2,  name: "EQ Bank",               kind: "liquid",    groupLabel: "Budget Accounts", balance: "10383079",  onBudget: true,  sort: 1 },
  { id: 3,  name: "Scotia e-Chequing",     kind: "liquid",    groupLabel: "Budget Accounts", balance: "45823",     onBudget: true,  sort: 2 },
  { id: 4,  name: "Cash",                  kind: "liquid",    groupLabel: "Budget Accounts", balance: "11605",     onBudget: true,  sort: 3 },
  // On-budget: credit cards
  { id: 5,  name: "AMEX Cobalt",           kind: "credit",    groupLabel: "Credit Cards",    balance: "-389784",   onBudget: true,  sort: 4 },
  { id: 6,  name: "Scotia Passport Visa",  kind: "credit",    groupLabel: "Credit Cards",    balance: "-10348",    onBudget: true,  sort: 5 },
  { id: 7,  name: "Rogers World Elite MC", kind: "credit",    groupLabel: "Credit Cards",    balance: "0",         onBudget: true,  sort: 6 },
  { id: 8,  name: "Capital One Aspire MC", kind: "credit",    groupLabel: "Credit Cards",    balance: "0",         onBudget: true,  sort: 7 },
  // Tracking (reimbursement)
  { id: 9,  name: "Susie",                 kind: "liquid",    groupLabel: "Tracking",        balance: "-67428",    onBudget: true,  sort: 8 },
  { id: 10, name: "Parents",               kind: "liquid",    groupLabel: "Tracking",        balance: "373535",    onBudget: true,  sort: 9 },
  // Off-budget: investments
  { id: 11, name: "Wealthsimple Trade",    kind: "offbudget", groupLabel: "Investments",     balance: "0",         onBudget: false, sort: 10 },
  { id: 12, name: "Wealthsimple TFSA",     kind: "offbudget", groupLabel: "Investments",     balance: "15367437",  onBudget: false, sort: 11 },
  { id: 13, name: "Wealthsimple RRSP",     kind: "offbudget", groupLabel: "Investments",     balance: "19670022",  onBudget: false, sort: 12 },
  { id: 14, name: "Manulife GRSP",         kind: "offbudget", groupLabel: "Investments",     balance: "9921386",   onBudget: false, sort: 13 },
  { id: 15, name: "EquatePlus SAP",        kind: "offbudget", groupLabel: "Investments",     balance: "235741",    onBudget: false, sort: 14 },
  { id: 16, name: "British Airways Credit",kind: "offbudget", groupLabel: "Investments",     balance: "35700",     onBudget: false, sort: 15 },
  // Off-budget: property
  { id: 17, name: "Home Value",            kind: "offbudget", groupLabel: "Property",        balance: "97900000",  onBudget: false, sort: 16 },
  { id: 18, name: "Mortgage Debt",         kind: "offbudget", groupLabel: "Property",        balance: "-66025355", onBudget: false, sort: 17 },
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
  { id: 1,  groupId: 1, name: "Mortgage Principal",             sort: 0, carryover: "0",       goalTarget: null,      linkedAccountId: null },
  { id: 2,  groupId: 1, name: "Mortgage Interest",              sort: 1, carryover: "0",       goalTarget: null,      linkedAccountId: null },
  { id: 3,  groupId: 1, name: "Property Taxes",                 sort: 2, carryover: "0",       goalTarget: "840000",  linkedAccountId: null },
  { id: 4,  groupId: 1, name: "Condo Fees/HOA",                 sort: 3, carryover: "-43900",  goalTarget: null,      linkedAccountId: null },
  { id: 5,  groupId: 1, name: "Home Insurance",                 sort: 4, carryover: "0",       goalTarget: "240000",  linkedAccountId: null },
  { id: 6,  groupId: 1, name: "Home Maintenance",               sort: 5, carryover: "0",       goalTarget: null,      linkedAccountId: null },

  // Needs
  { id: 7,  groupId: 2, name: "Rent",                           sort: 0, carryover: "0",       goalTarget: null,      linkedAccountId: null },
  { id: 8,  groupId: 2, name: "Utilities, Electricity, Water",  sort: 1, carryover: "0",       goalTarget: null,      linkedAccountId: null },
  { id: 9,  groupId: 2, name: "Internet, iPhone",               sort: 2, carryover: "0",       goalTarget: null,      linkedAccountId: null },
  { id: 10, groupId: 2, name: "Household",                      sort: 3, carryover: "-123118", goalTarget: null,      linkedAccountId: null },
  { id: 11, groupId: 2, name: "Groceries",                      sort: 4, carryover: "15965",   goalTarget: null,      linkedAccountId: null },
  { id: 12, groupId: 2, name: "Dental, Optical, Counselling",   sort: 5, carryover: "0",       goalTarget: "400000",  linkedAccountId: null },
  { id: 13, groupId: 2, name: "Public Transport, Uber, Bike",   sort: 6, carryover: "-1193",   goalTarget: null,      linkedAccountId: null },
  { id: 14, groupId: 2, name: "Fees, Charges, Loans",           sort: 7, carryover: "-28447",  goalTarget: null,      linkedAccountId: null },
  { id: 15, groupId: 2, name: "Other Needs",                    sort: 8, carryover: "286884",  goalTarget: null,      linkedAccountId: null },

  // Wants
  { id: 16, groupId: 3, name: "Eat/Drink Out, Alcohol",         sort: 0, carryover: "-185485", goalTarget: null,      linkedAccountId: null },
  { id: 17, groupId: 3, name: "Sport, Exercise",                sort: 1, carryover: "0",       goalTarget: null,      linkedAccountId: null },
  { id: 18, groupId: 3, name: "Lessons (Sailing, Guitar)",      sort: 2, carryover: "-71860",  goalTarget: null,      linkedAccountId: null },
  { id: 19, groupId: 3, name: "Travels, Flights",               sort: 3, carryover: "0",       goalTarget: null,      linkedAccountId: null },
  { id: 20, groupId: 3, name: "Car Rental, Petrol",             sort: 4, carryover: "-198581", goalTarget: null,      linkedAccountId: null },
  { id: 21, groupId: 3, name: "Computers, Games, Guitar",       sort: 5, carryover: "224611",  goalTarget: null,      linkedAccountId: null },
  { id: 22, groupId: 3, name: "Clothing",                       sort: 6, carryover: "-45945",  goalTarget: null,      linkedAccountId: null },
  { id: 23, groupId: 3, name: "Work/Family",                    sort: 7, carryover: "-362587", goalTarget: null,      linkedAccountId: null },
  { id: 24, groupId: 3, name: "Other Wants",                    sort: 8, carryover: "28099",   goalTarget: null,      linkedAccountId: null },

  // Savings & Investments
  { id: 25, groupId: 4, name: "Retirement",                     sort: 0, carryover: "0",       goalTarget: null,      linkedAccountId: null },
  { id: 26, groupId: 4, name: "Manulife GRSP",                  sort: 1, carryover: "21622",   goalTarget: null,      linkedAccountId: null },
  { id: 27, groupId: 4, name: "EquatePlus SAP",                 sort: 2, carryover: "-103654", goalTarget: null,      linkedAccountId: null },
  { id: 28, groupId: 4, name: "Other Investments",              sort: 3, carryover: "0",       goalTarget: null,      linkedAccountId: null },

  // Credit Card Payments (linked to CC accounts)
  { id: 29, groupId: 5, name: "AMEX Cobalt",           sort: 0, carryover: "389784", goalTarget: null, linkedAccountId: 5 },
  { id: 30, groupId: 5, name: "Scotia Passport Visa",  sort: 1, carryover: "10348",  goalTarget: null, linkedAccountId: 6 },
  { id: 31, groupId: 5, name: "Rogers World Elite MC", sort: 2, carryover: "0",      goalTarget: null, linkedAccountId: 7 },
  { id: 32, groupId: 5, name: "Capital One Aspire MC", sort: 3, carryover: "0",      goalTarget: null, linkedAccountId: 8 },
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
// ASSIGNMENTS — budgeted amounts for June 2026 (DEMO_MONTH) in cents
// ---------------------------------------------------------------------------
const assignments: Assignment[] = [
  // Housing
  { id:  1, categoryId: cid("Mortgage Principal"),           month: DEMO_MONTH, amount: "180000"  },
  { id:  2, categoryId: cid("Mortgage Interest"),            month: DEMO_MONTH, amount: "235297"  },
  { id:  3, categoryId: cid("Property Taxes"),               month: DEMO_MONTH, amount: "0"       },
  { id:  4, categoryId: cid("Condo Fees/HOA"),               month: DEMO_MONTH, amount: "43900"   },
  { id:  5, categoryId: cid("Home Insurance"),               month: DEMO_MONTH, amount: "0"       },
  { id:  6, categoryId: cid("Home Maintenance"),             month: DEMO_MONTH, amount: "0"       },
  // Needs
  { id:  7, categoryId: cid("Rent"),                         month: DEMO_MONTH, amount: "200000"  },
  { id:  8, categoryId: cid("Utilities, Electricity, Water"),month: DEMO_MONTH, amount: "15000"   },
  { id:  9, categoryId: cid("Internet, iPhone"),             month: DEMO_MONTH, amount: "20000"   },
  { id: 10, categoryId: cid("Household"),                    month: DEMO_MONTH, amount: "20000"   },
  { id: 11, categoryId: cid("Groceries"),                    month: DEMO_MONTH, amount: "100000"  },
  { id: 12, categoryId: cid("Dental, Optical, Counselling"), month: DEMO_MONTH, amount: "40000"   },
  { id: 13, categoryId: cid("Public Transport, Uber, Bike"), month: DEMO_MONTH, amount: "7500"    },
  { id: 14, categoryId: cid("Fees, Charges, Loans"),         month: DEMO_MONTH, amount: "3500"    },
  { id: 15, categoryId: cid("Other Needs"),                  month: DEMO_MONTH, amount: "5000"    },
  // Wants
  { id: 16, categoryId: cid("Eat/Drink Out, Alcohol"),       month: DEMO_MONTH, amount: "100000"  },
  { id: 17, categoryId: cid("Sport, Exercise"),              month: DEMO_MONTH, amount: "0"       },
  { id: 18, categoryId: cid("Lessons (Sailing, Guitar)"),    month: DEMO_MONTH, amount: "0"       },
  { id: 19, categoryId: cid("Travels, Flights"),             month: DEMO_MONTH, amount: "100000"  },
  { id: 20, categoryId: cid("Car Rental, Petrol"),           month: DEMO_MONTH, amount: "0"       },
  { id: 21, categoryId: cid("Computers, Games, Guitar"),     month: DEMO_MONTH, amount: "60000"   },
  { id: 22, categoryId: cid("Clothing"),                     month: DEMO_MONTH, amount: "7560"    },
  { id: 23, categoryId: cid("Work/Family"),                  month: DEMO_MONTH, amount: "100000"  },
  { id: 24, categoryId: cid("Other Wants"),                  month: DEMO_MONTH, amount: "100000"  },
  // Savings
  { id: 25, categoryId: cid("Retirement"),                   month: DEMO_MONTH, amount: "45550"   },
  { id: 26, categoryId: cid("Manulife GRSP"),                month: DEMO_MONTH, amount: "0"       },
  { id: 27, categoryId: cid("EquatePlus SAP"),               month: DEMO_MONTH, amount: "0"       },
  { id: 28, categoryId: cid("Other Investments"),            month: DEMO_MONTH, amount: "0"       },

  // ── May 2026 assignments (prior month for carryover math) ─────────────────
  { id: 29, categoryId: cid("Mortgage Principal"),           month: "2026-05", amount: "180000"  },
  { id: 30, categoryId: cid("Mortgage Interest"),            month: "2026-05", amount: "235297"  },
  { id: 31, categoryId: cid("Condo Fees/HOA"),               month: "2026-05", amount: "43900"   },
  { id: 32, categoryId: cid("Internet, iPhone"),             month: "2026-05", amount: "20000"   },
  { id: 33, categoryId: cid("Utilities, Electricity, Water"),month: "2026-05", amount: "15000"   },
  { id: 34, categoryId: cid("Groceries"),                    month: "2026-05", amount: "100000"  },
  { id: 35, categoryId: cid("Household"),                    month: "2026-05", amount: "20000"   },
  { id: 36, categoryId: cid("Eat/Drink Out, Alcohol"),       month: "2026-05", amount: "100000"  },
  { id: 37, categoryId: cid("Public Transport, Uber, Bike"), month: "2026-05", amount: "7500"    },
  { id: 38, categoryId: cid("Retirement"),                   month: "2026-05", amount: "45550"   },
  { id: 39, categoryId: cid("Rent"),                         month: "2026-05", amount: "200000"  },
  { id: 40, categoryId: cid("Dental, Optical, Counselling"), month: "2026-05", amount: "40000"   },
  { id: 41, categoryId: cid("Fees, Charges, Loans"),         month: "2026-05", amount: "3500"    },
  { id: 42, categoryId: cid("Lessons (Sailing, Guitar)"),    month: "2026-05", amount: "71860"   },
  { id: 43, categoryId: cid("Travels, Flights"),             month: "2026-05", amount: "100000"  },
  { id: 44, categoryId: cid("Computers, Games, Guitar"),     month: "2026-05", amount: "60000"   },
  { id: 45, categoryId: cid("Work/Family"),                  month: "2026-05", amount: "100000"  },
  { id: 46, categoryId: cid("Other Wants"),                  month: "2026-05", amount: "100000"  },
  { id: 47, categoryId: cid("Other Needs"),                  month: "2026-05", amount: "5000"    },
  { id: 48, categoryId: cid("Clothing"),                     month: "2026-05", amount: "7560"    },
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
  status: "u" | "c" | "r" = "c",
  isIncome = false,
  transferAccountId: number | null = null
): Transaction => ({
  id: _tid++,
  accountId,
  categoryId,
  date,
  payee,
  amount,
  memo,
  status,
  isIncome,
  transferAccountId,
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
  T(aid("EQ Bank"),               null,                         "2026-04-15", "SAP Concur",               "442865",  "Income for April", "c", true),
  T(aid("EQ Bank"),               null,                         "2026-04-29", "SAP Concur",               "442865",  "Income for April", "c", true),
  T(aid("TD Unlimited Chequing"), cid("Mortgage Principal"),    "2026-04-01", "TD Bank",                  "-180000", "Housing: Mortgage Principal"),
  T(aid("TD Unlimited Chequing"), cid("Mortgage Interest"),     "2026-04-01", "TD Bank",                  "-235297", "Housing: Mortgage Interest"),
  T(aid("TD Unlimited Chequing"), cid("Condo Fees/HOA"),        "2026-04-01", "Mountain's Edge MSP",      "-43900",  "BC405"),
  T(aid("AMEX Cobalt"),           cid("Utilities, Electricity, Water"), "2026-04-25", "Fortis BC",        "-30385",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-04-05", "Superstore",               "-18742",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-04-12", "Save-On-Foods",            "-14360",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-04-19", "Costco",                   "-21233",  "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-04-08", "Cactus Club",              "-14200",  "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-04-17", "Jam Café",                 "-5420",   ""),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-04-22", "Parallel 49 Brewing",      "-6740",   "Split with Susie"),
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-04-10", "Telus",                    "-11000",  ""),
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-04-10", "Fido",                     "-9000",   ""),
  T(aid("Susie"),                 null,                         "2026-04-30", "Susie",                    "32015",   "April shared expenses reimbursement", "c", true),

  // ── May 2026 ──────────────────────────────────────────────────────────────
  T(aid("EQ Bank"),               null,                         "2026-05-15", "SAP Concur",               "442865",  "Income for May", "c", true),
  T(aid("EQ Bank"),               null,                         "2026-05-29", "SAP Concur",               "442865",  "Income for May", "c", true),
  T(aid("TD Unlimited Chequing"), cid("Mortgage Principal"),    "2026-05-01", "TD Bank",                  "-180000", "Housing: Mortgage Principal"),
  T(aid("TD Unlimited Chequing"), cid("Mortgage Interest"),     "2026-05-01", "TD Bank",                  "-235297", "Housing: Mortgage Interest"),
  T(aid("TD Unlimited Chequing"), cid("Condo Fees/HOA"),        "2026-05-01", "Mountain's Edge MSP",      "-43900",  "BC405"),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-05-06", "Superstore",               "-19655",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-05-14", "Save-On-Foods",            "-13820",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-05-21", "T&T Supermarket",          "-8935",   ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-05-28", "Costco",                   "-24578",  "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-05-10", "Miku Restaurant",          "-21840",  "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-05-16", "Tacofino",                 "-5890",   ""),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-05-23", "Browns Social House",      "-9730",   "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Utilities, Electricity, Water"), "2026-05-25", "Fortis BC",        "-28129",  ""),
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-05-10", "Telus",                    "-11000",  ""),
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-05-10", "Fido",                     "-9000",   ""),
  T(aid("AMEX Cobalt"),           cid("Household"),             "2026-05-12", "Home Depot",               "-9471",   ""),
  T(aid("AMEX Cobalt"),           cid("Household"),             "2026-05-20", "Ikea",                     "-16350",  "Split with Susie"),
  T(aid("TD Unlimited Chequing"), cid("Lessons (Sailing, Guitar)"), "2026-05-01", "Jericho Sailing Centre","-71860", "Annual membership"),
  T(aid("AMEX Cobalt"),           cid("Public Transport, Uber, Bike"), "2026-05-18", "Uber",             "-3193",   ""),
  T(aid("Susie"),                 null,                         "2026-05-31", "Susie",                    "35040",   "May shared expenses reimbursement", "c", true),
  T(aid("TD Unlimited Chequing"), null,                         "2026-05-20", "AMEX Payment",             "-353105", "Card payment", "c", false, aid("AMEX Cobalt")),

  // ── June 2026 (DEMO_MONTH) ─────────────────────────────────────────────────
  T(aid("EQ Bank"),               null,                         "2026-06-16", "SAP Concur",               "415297",  "Income for June", "c", true),
  T(aid("EQ Bank"),               null,                         "2026-06-30", "SAP Concur",               "415297",  "Income for June", "c", true),
  T(aid("EQ Bank"),               null,                         "2026-06-09", "TD Bank",                  "50000",   "bonus", "c", true),
  // Transfer EQ → TD to cover mortgage
  T(aid("EQ Bank"),               null,                         "2026-06-01", "Transfer: TD Unlimited Chequing", "-415297", "", "c", false, aid("TD Unlimited Chequing")),
  // Mortgage
  T(aid("TD Unlimited Chequing"), cid("Mortgage Principal"),    "2026-06-01", "TD Bank",                  "-180000", "Housing: Mortgage Principal"),
  T(aid("TD Unlimited Chequing"), cid("Mortgage Interest"),     "2026-06-01", "TD Bank",                  "-235297", "Housing: Mortgage Interest"),
  // Condo
  T(aid("TD Unlimited Chequing"), cid("Condo Fees/HOA"),        "2026-06-02", "Mountain's Edge MSP",      "-43900",  "BC405"),
  // Phone / internet
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-06-10", "Telus",                    "-11000",  ""),
  T(aid("TD Unlimited Chequing"), cid("Internet, iPhone"),      "2026-06-10", "Fido",                     "-9000",   ""),
  // Utilities
  T(aid("AMEX Cobalt"),           cid("Utilities, Electricity, Water"), "2026-06-25", "Fortis BC",        "-30385",  ""),
  // Groceries
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-06-04", "Superstore",               "-20318",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-06-11", "Save-On-Foods",            "-15542",  ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-06-18", "T&T Supermarket",          "-9374",   ""),
  T(aid("AMEX Cobalt"),           cid("Groceries"),             "2026-06-25", "Costco",                   "-22906",  "Split with Susie"),
  // Dining / drinks
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-06-07", "Published on Main",        "-17850",  "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-06-13", "St. Augustine's Pub",      "-8730",   "Split with Susie"),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-06-20", "Nemesis Coffee",           "-4215",   ""),
  T(aid("AMEX Cobalt"),           cid("Eat/Drink Out, Alcohol"),"2026-06-26", "Boulevard Kitchen",        "-20480",  ""),
  // Household
  T(aid("AMEX Cobalt"),           cid("Household"),             "2026-06-08", "Home Depot",               "-7342",   ""),
  // Transport
  T(aid("AMEX Cobalt"),           cid("Public Transport, Uber, Bike"), "2026-06-14", "Uber",             "-2350",   ""),
  T(aid("AMEX Cobalt"),           cid("Public Transport, Uber, Bike"), "2026-06-22", "TransLink",        "-10000",  "3-month pass"),
  // Clothing
  T(aid("AMEX Cobalt"),           cid("Clothing"),              "2026-06-15", "Aritzia",                  "-18900",  ""),
  // Travel
  T(aid("EQ Bank"),               cid("Travels, Flights"),      "2026-06-01", "Air Canada",               "-120000", "Flights to Europe"),
  // Computers / tech
  T(aid("AMEX Cobalt"),           cid("Computers, Games, Guitar"),"2026-06-03","Apple Store",             "-40954",  "iPad keyboard"),
  // Dental
  T(aid("TD Unlimited Chequing"), cid("Dental, Optical, Counselling"), "2026-06-18", "Dr. Smith Dental", "-28523",  ""),
  // Work/Family
  T(aid("AMEX Cobalt"),           cid("Work/Family"),           "2026-06-12", "Amazon",                   "-14792",  ""),
  T(aid("AMEX Cobalt"),           cid("Work/Family"),           "2026-06-19", "Indigo Books",             "-5835",   ""),
  // TFSA contribution
  T(aid("EQ Bank"),               null,                         "2026-06-01", "Wealthsimple TFSA",        "-45550",  "Monthly TFSA contribution", "c", false, 12),
  // Susie shared expense split tracking
  T(aid("Susie"),                 null,                         "2026-06-07", "Published on Main (Susie share)", "-8925",  "Half of dinner"),
  T(aid("Susie"),                 null,                         "2026-06-13", "St. Augustine's (Susie share)",  "-4365",  "Half of pub tab"),
  T(aid("Susie"),                 null,                         "2026-06-25", "Costco groceries (Susie share)", "-11453", "Half of Costco run"),
  // AMEX payment from TD
  T(aid("TD Unlimited Chequing"), null,                         "2026-06-20", "AMEX Payment",             "-415297", "Card payment", "c", false, aid("AMEX Cobalt")),
  // Bank fee
  T(aid("TD Unlimited Chequing"), cid("Fees, Charges, Loans"),  "2026-06-30", "TD Bank",                  "-1795",   "Monthly bank fee"),
];

// ---------------------------------------------------------------------------
// RECURRING — scheduled transactions next firing in 2026-07 (in cents)
// ---------------------------------------------------------------------------
const recurring: (Recurring & { subTransactions: RecurringSubTransaction[] })[] = [
  // Mortgage
  { id: 1,  accountId: aid("TD Unlimited Chequing"), categoryId: cid("Mortgage Principal"),            payee: "TD Bank",                  amount: "-180000",    frequency: "monthly", nextDate: "2026-07-01", active: true, subTransactions: [] },
  { id: 2,  accountId: aid("TD Unlimited Chequing"), categoryId: cid("Mortgage Interest"),             payee: "TD Bank",                  amount: "-235297",    frequency: "monthly", nextDate: "2026-07-01", active: true, subTransactions: [] },
  // Condo
  { id: 3,  accountId: aid("TD Unlimited Chequing"), categoryId: cid("Condo Fees/HOA"),                payee: "Mountain's Edge MSP",       amount: "-43900",     frequency: "monthly", nextDate: "2026-07-01", active: true, subTransactions: [] },
  // Internet / phone
  { id: 4,  accountId: aid("TD Unlimited Chequing"), categoryId: cid("Internet, iPhone"),              payee: "Telus",                     amount: "-11000",     frequency: "monthly", nextDate: "2026-07-10", active: true, subTransactions: [] },
  { id: 5,  accountId: aid("TD Unlimited Chequing"), categoryId: cid("Internet, iPhone"),              payee: "Fido",                      amount: "-9000",      frequency: "monthly", nextDate: "2026-07-10", active: true, subTransactions: [] },
  // Utilities
  { id: 6,  accountId: aid("AMEX Cobalt"),           categoryId: cid("Utilities, Electricity, Water"), payee: "Fortis BC",                 amount: "-30000",     frequency: "monthly", nextDate: "2026-07-25", active: true, subTransactions: [] },
  // Payroll — biweekly (two entries)
  { id: 7,  accountId: aid("EQ Bank"),               categoryId: null,                                 payee: "SAP Concur",                amount: "415297",     frequency: "monthly", nextDate: "2026-07-16", active: true, subTransactions: [] },
  { id: 8,  accountId: aid("EQ Bank"),               categoryId: null,                                 payee: "SAP Concur",                amount: "415297",     frequency: "monthly", nextDate: "2026-07-30", active: true, subTransactions: [] },
  // TFSA contribution
  { id: 9,  accountId: aid("EQ Bank"),               categoryId: null,                                 payee: "Wealthsimple TFSA",         amount: "-45550",     frequency: "monthly", nextDate: "2026-07-01", active: true, transferAccountId: 12, subTransactions: [] },
  // Sailing (annual)
  { id: 10, accountId: aid("TD Unlimited Chequing"), categoryId: cid("Lessons (Sailing, Guitar)"),     payee: "Jericho Sailing Centre",    amount: "-71860",     frequency: "yearly",  nextDate: "2027-05-01", active: true, subTransactions: [] },
];

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export function makeSeedBudgetData(): BudgetData {
  return { accounts, groups, categories, assignments, transactions, recurring, renameRules: [] };
}
