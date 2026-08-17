import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  groupLabel: text("group_label").notNull(),
  balance: integer("balance").notNull().default(0),
  onBudget: integer("on_budget", { mode: "boolean" }).notNull().default(true),
  sort: integer("sort").notNull().default(0),
  lastReconciledAt: text("last_reconciled_at"),
  lastReconciledBalance: integer("last_reconciled_balance"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
});

export const categoryGroups = sqliteTable("category_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
  isCreditCardPayments: integer("is_credit_card_payments", { mode: "boolean" }).notNull().default(false),
});

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupId: integer("group_id")
    .notNull()
    .references(() => categoryGroups.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
  carryover: integer("carryover").notNull().default(0),
  goalTarget: integer("goal_target"),
  linkedAccountId: integer("linked_account_id").references(() => accounts.id, {
    onDelete: "cascade",
  }),
  overspendCarriesOver: integer("overspend_carries_over", { mode: "boolean" }).notNull().default(false),
});

export const assignments = sqliteTable(
  "assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    amount: integer("amount").notNull().default(0),
  },
  (t) => ({
    uniq: uniqueIndex("assignments_cat_month_uniq").on(t.categoryId, t.month),
  })
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    date: text("date").notNull(),
    payee: text("payee").notNull().default(""),
    memo: text("memo").notNull().default(""),
    amount: integer("amount").notNull().default(0),
    status: text("status", { enum: ["u", "c", "r"] }).notNull().default("c"),
    createdAt: text("created_at").notNull().default(""),
    parentId: integer("parent_id").references((): AnySQLiteColumn => transactions.id, { onDelete: "cascade" }),
    transferAccountId: integer("transfer_account_id").references(() => accounts.id, { onDelete: "set null" }),
    isIncome: integer("is_income", { mode: "boolean" }).notNull().default(false),
    incomeMonth: text("income_month"),
    reconciledAt: text("reconciled_at"),
    reconciliationId: integer("reconciliation_id"),
  },
  (t) => ({
    accountDateIdx: index("transactions_account_date_idx").on(t.accountId, t.date),
    dateIdx: index("transactions_date_idx").on(t.date),
    parentIdIdx: index("transactions_parent_id_idx").on(t.parentId),
    reconciliationIdIdx: index("transactions_reconciliation_id_idx").on(t.reconciliationId),
  })
);

export const reconciliations = sqliteTable(
  "reconciliations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    reconciledAt: text("reconciled_at").notNull(),
    statementDate: text("statement_date").notNull(),
    statementBalance: integer("statement_balance").notNull(),
    adjustmentTransactionId: integer("adjustment_transaction_id"),
  },
  (t) => ({
    accountIdx: index("reconciliations_account_idx").on(t.accountId),
  })
);

export const recurring = sqliteTable("recurring", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").references(() => categories.id, {
    onDelete: "set null",
  }),
  payee: text("payee").notNull().default(""),
  amount: integer("amount").notNull().default(0),
  frequency: text("frequency").notNull().default("monthly"),
  nextDate: text("next_date").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  transferAccountId: integer("transfer_account_id").references(() => accounts.id, { onDelete: "set null" }),
});

export const recurringSubTransactions = sqliteTable("recurring_sub_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recurringId: integer("recurring_id")
    .notNull()
    .references(() => recurring.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").references(() => categories.id, {
    onDelete: "set null",
  }),
  amount: integer("amount").notNull().default(0),
  memo: text("memo").notNull().default(""),
  sort: integer("sort").notNull().default(0),
  transferAccountId: integer("transfer_account_id").references(() => accounts.id, { onDelete: "set null" }),
});

export type Account = typeof accounts.$inferSelect;
export type CategoryGroup = typeof categoryGroups.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Reconciliation = typeof reconciliations.$inferSelect;
export type Recurring = typeof recurring.$inferSelect;
export type RecurringSubTransaction = typeof recurringSubTransactions.$inferSelect;
