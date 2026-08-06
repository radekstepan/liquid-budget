import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  groupLabel: text("group_label").notNull(),
  balance: real("balance").notNull().default(0),
  onBudget: integer("on_budget", { mode: "boolean" }).notNull().default(true),
  sort: integer("sort").notNull().default(0),
  lastReconciledAt: text("last_reconciled_at"),
  lastReconciledBalance: real("last_reconciled_balance"),
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
  carryover: real("carryover").notNull().default(0),
  goalTarget: real("goal_target"),
  linkedAccountId: integer("linked_account_id").references(() => accounts.id, {
    onDelete: "cascade",
  }),
});

export const assignments = sqliteTable(
  "assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    amount: real("amount").notNull().default(0),
  },
  (t) => ({
    uniq: uniqueIndex("assignments_cat_month_uniq").on(t.categoryId, t.month),
  })
);

export const transactions = sqliteTable("transactions", {
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
  amount: real("amount").notNull().default(0),
  status: text("status", { enum: ["u", "c", "r"] }).notNull().default("c"),
  createdAt: text("created_at").notNull().default(""),
  parentId: integer("parent_id").references((): AnySQLiteColumn => transactions.id, { onDelete: "cascade" }),
  transferAccountId: integer("transfer_account_id").references(() => accounts.id, { onDelete: "set null" }),
});

export const recurring = sqliteTable("recurring", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").references(() => categories.id, {
    onDelete: "set null",
  }),
  payee: text("payee").notNull().default(""),
  amount: real("amount").notNull().default(0),
  frequency: text("frequency").notNull().default("monthly"),
  nextDate: text("next_date").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  transferAccountId: integer("transfer_account_id").references(() => accounts.id, { onDelete: "set null" }),
});
// ^ `transfer_account_id` is in the schema from day one (was previously
//   added at boot by an ALTER TABLE inside a try/catch in seed.ts).

export const recurringSubTransactions = sqliteTable("recurring_sub_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recurringId: integer("recurring_id")
    .notNull()
    .references(() => recurring.id, { onDelete: "cascade" }),
  // Nullable + ON DELETE SET NULL (matches `transactions.categoryId`) so that
  // deleting a category that happens to be used in a recurring split
  // does not crash with a foreign key constraint violation. The recurring
  // children simply end up uncategorised.
  categoryId: integer("category_id").references(() => categories.id, {
    onDelete: "set null",
  }),
  amount: real("amount").notNull().default(0),
  memo: text("memo").notNull().default(""),
  sort: integer("sort").notNull().default(0),
});

export type Account = typeof accounts.$inferSelect;
export type CategoryGroup = typeof categoryGroups.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Recurring = typeof recurring.$inferSelect;
export type RecurringSubTransaction = typeof recurringSubTransactions.$inferSelect;
