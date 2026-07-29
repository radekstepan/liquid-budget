import type { Account, Assignment, BudgetData, Category, CategoryGroup, Recurring, Transaction } from "./types.js";

export const DEMO_MONTH = "2025-07";

const accounts: Account[] = [
  { id: 1, name: "Cash", kind: "liquid", groupLabel: "Liquid", balance: "320.00", onBudget: true, sort: 0 },
  { id: 2, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "1658.08", onBudget: true, sort: 1 },
  { id: 3, name: "Savings", kind: "liquid", groupLabel: "Liquid", balance: "1500.00", onBudget: true, sort: 2 },
  { id: 4, name: "Chase", kind: "credit", groupLabel: "Credit Cards", balance: "-823.47", onBudget: true, sort: 3 },
  { id: 5, name: "Visa", kind: "credit", groupLabel: "Credit Cards", balance: "-1450.00", onBudget: true, sort: 4 },
  { id: 6, name: "Amex", kind: "credit", groupLabel: "Credit Cards", balance: "-412.30", onBudget: true, sort: 5 },
  { id: 7, name: "Retirement", kind: "offbudget", groupLabel: "Retirement", balance: "58000.00", onBudget: false, sort: 6 },
];

const groups: CategoryGroup[] = [
  { id: 1, name: "Discretionary", sort: 0, isCreditCardPayments: false },
  { id: 2, name: "Monthly Expenses", sort: 1, isCreditCardPayments: false },
  { id: 3, name: "Scheduled Expenses", sort: 2, isCreditCardPayments: false },
  { id: 4, name: "Savings", sort: 3, isCreditCardPayments: false },
  { id: 5, name: "Credit Card Payments", sort: 4, isCreditCardPayments: true },
];

const categories: Category[] = [
  { id: 1, groupId: 1, name: "Groceries", sort: 0, carryover: "18.50", goalTarget: null, linkedAccountId: null },
  { id: 2, groupId: 1, name: "Household", sort: 1, carryover: "12.00", goalTarget: null, linkedAccountId: null },
  { id: 3, groupId: 1, name: "Dining Out", sort: 2, carryover: "0.00", goalTarget: null, linkedAccountId: null },
  { id: 4, groupId: 2, name: "Mortgage", sort: 0, carryover: "0.00", goalTarget: null, linkedAccountId: null },
  { id: 5, groupId: 2, name: "Electric", sort: 1, carryover: "0.00", goalTarget: null, linkedAccountId: null },
  { id: 6, groupId: 2, name: "Internet", sort: 2, carryover: "0.00", goalTarget: null, linkedAccountId: null },
  { id: 7, groupId: 2, name: "Netflix", sort: 3, carryover: "0.00", goalTarget: null, linkedAccountId: null },
  { id: 8, groupId: 3, name: "Pest Control", sort: 0, carryover: "0.00", goalTarget: null, linkedAccountId: null },
  { id: 9, groupId: 3, name: "Home Insurance", sort: 1, carryover: "0.00", goalTarget: "1000.00", linkedAccountId: null },
  { id: 10, groupId: 3, name: "Amazon Prime", sort: 2, carryover: "18.00", goalTarget: null, linkedAccountId: null },
  { id: 11, groupId: 4, name: "Rainy Day", sort: 0, carryover: "0.00", goalTarget: null, linkedAccountId: null },
  { id: 12, groupId: 4, name: "Retirement Fund", sort: 1, carryover: "0.00", goalTarget: null, linkedAccountId: null },
  { id: 13, groupId: 5, name: "Chase", sort: 0, carryover: "823.47", goalTarget: null, linkedAccountId: 4 },
  { id: 14, groupId: 5, name: "Visa", sort: 1, carryover: "1450.00", goalTarget: null, linkedAccountId: 5 },
  { id: 15, groupId: 5, name: "Amex", sort: 2, carryover: "412.30", goalTarget: null, linkedAccountId: 6 },
];

const assignments: Assignment[] = [
  { id: 1, categoryId: 1, month: DEMO_MONTH, amount: "550.00" },
  { id: 2, categoryId: 2, month: DEMO_MONTH, amount: "100.00" },
  { id: 3, categoryId: 3, month: DEMO_MONTH, amount: "200.00" },
  { id: 4, categoryId: 4, month: DEMO_MONTH, amount: "1850.00" },
  { id: 5, categoryId: 5, month: DEMO_MONTH, amount: "160.00" },
  { id: 6, categoryId: 6, month: DEMO_MONTH, amount: "80.00" },
  { id: 7, categoryId: 7, month: DEMO_MONTH, amount: "16.00" },
  { id: 8, categoryId: 8, month: DEMO_MONTH, amount: "45.00" },
  { id: 9, categoryId: 9, month: DEMO_MONTH, amount: "110.00" },
  { id: 10, categoryId: 10, month: DEMO_MONTH, amount: "180.00" },
  { id: 11, categoryId: 11, month: DEMO_MONTH, amount: "400.00" },
  { id: 12, categoryId: 12, month: DEMO_MONTH, amount: "300.00" },
];

const transactions: Transaction[] = [
  { id: 1, accountId: 2, categoryId: 1, date: "2025-07-03", payee: "Whole Foods", memo: "", amount: "-102.34", cleared: true },
  { id: 2, accountId: 4, categoryId: 1, date: "2025-07-09", payee: "Trader Joe's", memo: "", amount: "-87.16", cleared: true },
  { id: 3, accountId: 2, categoryId: 1, date: "2025-07-16", payee: "Safeway", memo: "", amount: "-120.00", cleared: true },
  { id: 4, accountId: 5, categoryId: 1, date: "2025-07-24", payee: "Costco", memo: "", amount: "-79.00", cleared: true },
  { id: 5, accountId: 6, categoryId: 2, date: "2025-07-05", payee: "Target", memo: "", amount: "-42.42", cleared: true },
  { id: 6, accountId: 4, categoryId: 2, date: "2025-07-18", payee: "Amazon", memo: "", amount: "-25.00", cleared: true },
  { id: 7, accountId: 5, categoryId: 3, date: "2025-07-06", payee: "Cheesecake Factory", memo: "", amount: "-85.00", cleared: true },
  { id: 8, accountId: 4, categoryId: 3, date: "2025-07-11", payee: "Chipotle", memo: "", amount: "-45.50", cleared: true },
  { id: 9, accountId: 5, categoryId: 3, date: "2025-07-19", payee: "Sushi Palace", memo: "", amount: "-120.00", cleared: true },
  { id: 10, accountId: 6, categoryId: 3, date: "2025-07-27", payee: "Starbucks", memo: "", amount: "-49.50", cleared: true },
  { id: 11, accountId: 2, categoryId: 4, date: "2025-07-01", payee: "Wells Fargo Home Mortgage", memo: "", amount: "-1850.00", cleared: true },
  { id: 12, accountId: 2, categoryId: 5, date: "2025-07-14", payee: "PG&E", memo: "", amount: "-143.27", cleared: true },
  { id: 13, accountId: 5, categoryId: 10, date: "2025-07-21", payee: "Amazon Prime", memo: "Annual membership", amount: "-180.00", cleared: true },
  { id: 14, accountId: 2, categoryId: null, date: "2025-07-01", payee: "Acme Corp Payroll", memo: "Paycheck", amount: "3200.00", cleared: true },
  { id: 15, accountId: 2, categoryId: null, date: "2025-07-15", payee: "Acme Corp Payroll", memo: "Paycheck", amount: "3200.00", cleared: true },
  { id: 16, accountId: 2, categoryId: 14, date: "2025-07-20", payee: "Visa Payment", memo: "Card payment", amount: "-300.00", cleared: true },
];

const recurring: Recurring[] = [
  { id: 1, accountId: 2, categoryId: 4, payee: "Wells Fargo Home Mortgage", amount: "-1850.00", frequency: "monthly", nextDate: "2025-08-01", active: true },
  { id: 2, accountId: 2, categoryId: 7, payee: "Netflix", amount: "-16.00", frequency: "monthly", nextDate: "2025-08-12", active: true },
  { id: 3, accountId: 2, categoryId: 6, payee: "Comcast", amount: "-80.00", frequency: "monthly", nextDate: "2025-08-08", active: true },
  { id: 4, accountId: 2, categoryId: null, payee: "Acme Corp Payroll", amount: "3200.00", frequency: "monthly", nextDate: "2025-08-01", active: true },
  { id: 5, accountId: 6, categoryId: 8, payee: "TerminatorX Pest", amount: "-45.00", frequency: "monthly", nextDate: "2025-08-15", active: true },
];

export function makeSeedBudgetData(): BudgetData {
  return { accounts, groups, categories, assignments, transactions, recurring };
}
