import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  boolean,
  date,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Accounts: liquid (cash/checking/savings), credit cards, off-budget (retirement)
export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // "liquid" | "credit" | "offbudget"
  kind: text("kind").notNull(),
  // display grouping label e.g. "Liquid", "Credit Cards", "Retirement"
  groupLabel: text("group_label").notNull(),
  balance: numeric("balance", { precision: 14, scale: 2 }).notNull().default("0"),
  onBudget: boolean("on_budget").notNull().default(true),
  sort: integer("sort").notNull().default(0),
});

// Category groups (Discretionary, Monthly Expenses, etc.)
export const categoryGroups = pgTable("category_groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
  // when true this group holds credit-card payment pools
  isCreditCardPayments: boolean("is_credit_card_payments").notNull().default(false),
});

// Categories (Groceries, Mortgage, ...)
export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id")
    .notNull()
    .references(() => categoryGroups.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
  // accumulated available carried in from prior months (base balance)
  carryover: numeric("carryover", { precision: 14, scale: 2 }).notNull().default("0"),
  // optional savings/funding goal target
  goalTarget: numeric("goal_target", { precision: 14, scale: 2 }),
  // for credit-card payment categories, the account this pool pays
  linkedAccountId: integer("linked_account_id").references(() => accounts.id, {
    onDelete: "cascade",
  }),
});

// Monthly assignments (budgeted amount per category per month)
export const assignments = pgTable(
  "assignments",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    // month as YYYY-MM
    month: text("month").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
  },
  (t) => ({
    uniq: uniqueIndex("assignments_cat_month_uniq").on(t.categoryId, t.month),
  })
);

// Transactions
export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").references(() => categories.id, {
    onDelete: "set null",
  }),
  date: date("date").notNull(),
  payee: text("payee").notNull().default(""),
  memo: text("memo").notNull().default(""),
  // negative = outflow, positive = inflow
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
  cleared: boolean("cleared").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Recurring transaction templates
export const recurring = pgTable("recurring", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").references(() => categories.id, {
    onDelete: "set null",
  }),
  payee: text("payee").notNull().default(""),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
  // "monthly" | "weekly" | "yearly"
  frequency: text("frequency").notNull().default("monthly"),
  // day of month for monthly
  nextDate: date("next_date").notNull(),
  active: boolean("active").notNull().default(true),
});

export type Account = typeof accounts.$inferSelect;
export type CategoryGroup = typeof categoryGroups.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Recurring = typeof recurring.$inferSelect;
