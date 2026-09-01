import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  check,
  AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityId: text("entity_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    groupLabel: text("group_label").notNull(),
    balance: integer("balance").notNull().default(0),
    onBudget: integer("on_budget", { mode: "boolean" }).notNull().default(true),
    sort: integer("sort").notNull().default(0),
    lastReconciledAt: text("last_reconciled_at"),
    lastReconciledBalance: integer("last_reconciled_balance"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    kindCheck: check("accounts_kind_check", sql`${t.kind} IN ('liquid', 'credit', 'offbudget')`),
  })
);

export const categoryGroups = sqliteTable(
  "category_groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityId: text("entity_id"),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    isCreditCardPayments: integer("is_credit_card_payments", { mode: "boolean" }).notNull().default(false),
    isHidden: integer("is_hidden", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    nameUniq: uniqueIndex("category_groups_name_uniq").on(t.name),
  })
);

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityId: text("entity_id"),
    groupId: integer("group_id")
      .notNull()
      .references(() => categoryGroups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    carryover: integer("carryover").notNull().default(0),
    goalTarget: integer("goal_target"),
    linkedAccountId: integer("linked_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    overspendCarriesOver: integer("overspend_carries_over", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    groupNameUniq: uniqueIndex("categories_group_name_uniq").on(t.groupId, t.name),
    linkedAccountUniq: uniqueIndex("categories_linked_account_uniq").on(t.linkedAccountId),
  })
);

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
    monthCatIdx: index("assignments_month_cat_idx").on(t.month, t.categoryId),
  })
);

export const payees = sqliteTable(
  "payees",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityId: text("entity_id"),
    name: text("name").notNull(),
    autoCategoryId: integer("auto_category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(""),
  },
  (t) => ({
    nameUniq: uniqueIndex("payees_name_uniq").on(t.name),
  })
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityId: text("entity_id"),
    transferEntityId: text("transfer_entity_id"),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    date: text("date").notNull(),
    payee: text("payee").notNull().default(""),
    payeeId: integer("payee_id").references(() => payees.id, { onDelete: "set null" }),
    memo: text("memo").notNull().default(""),
    amount: integer("amount").notNull().default(0),
    status: text("status", { enum: ["u", "c", "r"] }).notNull().default("c"),
    flagColor: text("flag_color"),
    createdAt: text("created_at").notNull().default(""),
    parentId: integer("parent_id").references((): AnySQLiteColumn => transactions.id, { onDelete: "cascade" }),
    transferAccountId: integer("transfer_account_id").references(() => accounts.id, { onDelete: "set null" }),
    transferStatus: text("transfer_status", { enum: ["u", "c", "r"] }).default("c"),
    isIncome: integer("is_income", { mode: "boolean" }).notNull().default(false),
    incomeMonth: text("income_month"),
    reconciledAt: text("reconciled_at"),
    reconciliationId: integer("reconciliation_id").references((): AnySQLiteColumn => reconciliations.id, {
      onDelete: "set null",
    }),
    transferReconciledAt: text("transfer_reconciled_at"),
    transferReconciliationId: integer("transfer_reconciliation_id").references((): AnySQLiteColumn => reconciliations.id, {
      onDelete: "set null",
    }),
  },
  (t) => ({
    accountDateIdx: index("transactions_account_date_idx").on(t.accountId, t.date),
    accountDateIdIdx: index("transactions_account_date_id_idx").on(t.accountId, t.date, t.id),
    dateIdx: index("transactions_date_idx").on(t.date),
    parentIdIdx: index("transactions_parent_id_idx").on(t.parentId),
    reconciliationIdIdx: index("transactions_reconciliation_id_idx").on(t.reconciliationId),
    transferReconciliationIdIdx: index("transactions_transfer_reconciliation_id_idx").on(t.transferReconciliationId),
    statusCheck: check("transactions_status_check", sql`${t.status} IN ('u', 'c', 'r')`),
    transferStatusCheck: check(
      "transactions_transfer_status_check",
      sql`${t.transferStatus} IS NULL OR ${t.transferStatus} IN ('u', 'c', 'r')`
    ),
    amountCheck: check("transactions_amount_check", sql`${t.amount} != 0`),
    transferNotSelfCheck: check(
      "transactions_transfer_not_self_check",
      sql`${t.transferAccountId} IS NULL OR ${t.accountId} != ${t.transferAccountId}`
    ),
  })
);

export const reconciliations = sqliteTable(
  "reconciliations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityId: text("entity_id"),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    reconciledAt: text("reconciled_at").notNull(),
    statementDate: text("statement_date").notNull(),
    statementBalance: integer("statement_balance").notNull(),
    adjustmentTransactionId: integer("adjustment_transaction_id").references(
      (): AnySQLiteColumn => transactions.id,
      { onDelete: "set null" }
    ),
  },
  (t) => ({
    accountIdx: index("reconciliations_account_idx").on(t.accountId),
  })
);

export const recurring = sqliteTable(
  "recurring",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityId: text("entity_id"),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    payee: text("payee").notNull().default(""),
    payeeId: integer("payee_id").references(() => payees.id, { onDelete: "set null" }),
    amount: integer("amount").notNull().default(0),
    frequency: text("frequency").notNull().default("monthly"),
    nextDate: text("next_date").notNull(),
    anchorDay: integer("anchor_day"),
    memo: text("memo").notNull().default(""),
    flagColor: text("flag_color"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    transferAccountId: integer("transfer_account_id").references(() => accounts.id, { onDelete: "set null" }),
  },
  (t) => ({
    accountIdx: index("recurring_account_id_idx").on(t.accountId),
    nextDateIdx: index("recurring_next_date_idx").on(t.nextDate),
    amountCheck: check("recurring_amount_check", sql`${t.amount} != 0`),
  })
);

export const recurringSubTransactions = sqliteTable(
  "recurring_sub_transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityId: text("entity_id"),
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
  },
  (t) => ({
    recurringIdIdx: index("recurring_sub_transactions_recurring_id_idx").on(t.recurringId),
    amountCheck: check("recurring_sub_amount_check", sql`${t.amount} != 0`),
  })
);

export const renameRules = sqliteTable(
  "rename_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /**
     * Source payee pattern to match. May contain `[N]` (matches one or more
     * digits). Matching is case- and whitespace-insensitive.
     */
    sourcePattern: text("source_pattern").notNull(),
    /** Payee to substitute when the source pattern matches. */
    targetPayee: text("target_payee").notNull(),
    createdAt: text("created_at").notNull().default(""),
    updatedAt: text("updated_at"),
  },
  (t) => ({
    uniq: uniqueIndex("rename_rules_source_target_uniq").on(t.sourcePattern, t.targetPayee),
  })
);

export type Account = typeof accounts.$inferSelect;
export type CategoryGroup = typeof categoryGroups.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Reconciliation = typeof reconciliations.$inferSelect;
export type Recurring = typeof recurring.$inferSelect;
export type RecurringSubTransaction = typeof recurringSubTransactions.$inferSelect;
export type RenameRule = typeof renameRules.$inferSelect;
