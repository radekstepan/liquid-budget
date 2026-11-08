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
    notes: text("notes").notNull().default(""),
    /**
     * Verbatim YNAB4 `AccountVO.accountType` (G-03: Checking, Savings,
     * CreditCard, Cash, LineofCredit, Paypal, MerchantAccount,
     * InvestmentAccount, Mortgage, OtherAsset, OtherLiability).
     * `kind` keeps driving app logic; the exporter prefers this raw
     * value when present so round-trips preserve the original type.
     * Null for accounts created in-app (kind mapping applies).
     */
    accountTypeRaw: text("account_type_raw"),
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
    /**
     * YNAB4 hidden-category lineage (`MangledHiddenNameComponents.as`):
     * a hidden sub-category stores its original home as a mangled name
     * "OldMaster ` Sub ` OldMasterEntityId" (2-part without the id in
     * older files). Import demangles the display `name` to the sub name
     * and persists the components here so unhide can restore the
     * original master (by entity id first, name fallback) and export
     * can re-mangle. Null for never-hidden categories and for hidden
     * rows whose wire name carried no backtick (e.g. our own pre-fix
     * exports, which wrote the plain name).
     */
    oldMasterName: text("old_master_name"),
    oldMasterEntityId: text("old_master_entity_id"),
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
    /**
     * YNAB4 `MonthlySubCategoryBudgetVO.note` (G-07). Month-level
     * `MonthlyBudget.note` has no home and is reported as a dropped
     * warning on import instead.
     */
    note: text("note").notNull().default(""),
  },
  (t) => ({
    uniq: uniqueIndex("assignments_cat_month_uniq").on(t.categoryId, t.month),
    monthCatIdx: index("assignments_month_cat_idx").on(t.month, t.categoryId),
  })
);

/**
 * Key-value store for budget-level settings imported from YNAB4
 * (G-02): locale/currency formatting from `.ybsettings`
 * (`currencySymbol`, `currencyISOSymbol`, `decimalSeparator`,
 * `groupSeparator`, `dateFormat`, `budgetName`) plus document metadata
 * from the `.ynab4` JSON root (`budgetType`, `currencyLocale`,
 * `dateLocale`, `strictBudget`). Wiped and rewritten on every YNAB4
 * import; read back by the YNAB4 exporter so locales round-trip.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const payees = sqliteTable(
  "payees",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityId: text("entity_id"),
    name: text("name").notNull(),
    autoCategoryId: integer("auto_category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    /**
     * YNAB4 `payees[].enabled === false` (disabled/hidden payees, G-04).
     * Mirrors `accounts.archived`; written back as `enabled` on export.
     */
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
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
    /**
     * YNAB4 `checkNumber` (G-05, `BaseTransactionVO`). Nullable free-text
     * (check users); round-tripped verbatim on export.
     */
    checkNumber: text("check_number"),
    /**
     * OFX-lineage fields (G-05, `MatchableTransactionVO`: `FITID`,
     * `YNABID`, `importedPayee`, `source`). Persisted verbatim so a
     * later OFX re-import can dedupe; not yet used for matching.
     */
    fitid: text("fitid"),
    ynabId: text("ynab_id"),
    importedPayee: text("imported_payee"),
    source: text("source"),
    /**
     * Verbatim YNAB4 income sentinel (`Category/__ImmediateIncome__`,
     * `Category/__DeferredIncome__`, or the legacy serialization names
     * `Category/__SupplementalIncome__` → Immediate,
     * `Category/__PrimaryIncome__` → Deferred) for rows imported as
     * income from one of those sentinels. Lets export restore the exact
     * wire name (including the losers of first-inflow-child-wins, so a
     * re-import classifies identically). Null for in-app rows and
     * categorized rows; cleared whenever an edit un-flags income or
     * re-specifies the category/income month.
     */
    incomeCategoryRaw: text("income_category_raw"),
    /**
     * Destination-leg memo + OFX lineage for single-row transfers
     * (mirrors `memo` / `checkNumber` / `fitid` / `ynabId` /
     * `importedPayee` / `source`). YNAB4 pairs carry independent per-leg
     * values; the import persists the dest side here and export prefers
     * it for the fabricated dest leg (falling back to the source value
     * when null, which is exactly the in-app/legacy state). Cleared when
     * the transfer is removed.
     */
    transferMemo: text("transfer_memo"),
    transferCheckNumber: text("transfer_check_number"),
    transferFitid: text("transfer_fitid"),
    transferYnabId: text("transfer_ynab_id"),
    transferImportedPayee: text("transfer_imported_payee"),
    transferSource: text("transfer_source"),
    flagColor: text("flag_color"),
    createdAt: text("created_at").notNull().default(""),
    parentId: integer("parent_id").references((): AnySQLiteColumn => transactions.id, { onDelete: "cascade" }),
    transferAccountId: integer("transfer_account_id").references(() => accounts.id, { onDelete: "set null" }),
    transferStatus: text("transfer_status", { enum: ["u", "c", "r"] }).default("c"),
    isIncome: integer("is_income", { mode: "boolean" }).notNull().default(false),
    incomeMonth: text("income_month"),
    /**
     * True for rows freshly added by a CSV import that the user has not
     * reviewed yet (YNAB4 shows these bold). Cleared by any user edit,
     * payee-manager cascade, or reconcile — automatic rename-rule and AI
     * backfills leave it untouched. Only flagged rows are eligible for
     * AI rename suggestions.
     */
    needsReview: integer("needs_review", { mode: "boolean" }).notNull().default(false),
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
    // No amount != 0 CHECK (G-06): YNAB4 split legs and zero-sum
    // parents import verbatim with amount 0. User-facing creation
    // still rejects zero via assertValidAmount; balance math is
    // unaffected (split parents are excluded from sums, zero legs
    // contribute 0).
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
    /**
     * YNAB4 `twiceAMonthStartDay` (G-08, `ScheduledTransactionVO`).
     * Second leg of twice-a-month schedules; null otherwise.
     */
    secondAnchorDay: integer("second_anchor_day"),
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

/**
 * Lineage of scheduled-posting occurrences: (schedule, occurrence date) ->
 * posted transaction row. Survives deletion of the posted row so that
 * re-posting the same occurrence restores the SAME row id and entity id,
 * mirroring YNAB4's deterministic
 * `idCreator.createTransactionIdForEnteredScheduledTransaction(
 *   scheduleEntityId, date)` (`ScheduledTransaction.as:184`).
 * Deleting the schedule cascades and drops its lineage.
 */
export const scheduledPostings = sqliteTable(
  "scheduled_postings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recurringId: integer("recurring_id")
      .notNull()
      .references(() => recurring.id, { onDelete: "cascade" }),
    occurrenceDate: text("occurrence_date").notNull(),
    /**
     * Id of the posted parent transaction row. Plain integer, deliberately
     * NOT a foreign key: the lineage must outlive the posted row so a
     * re-post can explicitly reuse the freed id.
     */
    transactionId: integer("transaction_id").notNull(),
    /** Deterministic posted entity id (`<sched>_<date>_<count>`). */
    entityId: text("entity_id").notNull(),
  },
  (t) => ({
    ruleDateUniq: uniqueIndex("scheduled_postings_rule_date_uniq").on(
      t.recurringId,
      t.occurrenceDate
    ),
    ruleIdx: index("scheduled_postings_rule_idx").on(t.recurringId),
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
    /**
     * Match flavour: `is` (exact, default), `contains`, `startsWith`,
     * `endsWith`. The substring flavours hold YNAB4 rename-condition
     * operators natively (see `@ynab/logic` rename-rules).
     */
    operator: text("operator").notNull().default("is"),
    createdAt: text("created_at").notNull().default(""),
    updatedAt: text("updated_at"),
  },
  (t) => ({
    uniq: uniqueIndex("rename_rules_source_target_uniq").on(t.sourcePattern, t.targetPayee, t.operator),
  })
);

/**
 * Duplicate fingerprints the user confirmed as legitimate. The analyzer
 * skips these groups so confirmed rows are never re-flagged.
 */
export const duplicateIgnores = sqliteTable("duplicate_ignores", {
  fingerprint: text("fingerprint").primaryKey(),
  createdAt: text("created_at").notNull().default(""),
});

export type Account = typeof accounts.$inferSelect;
export type CategoryGroup = typeof categoryGroups.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Reconciliation = typeof reconciliations.$inferSelect;
export type Recurring = typeof recurring.$inferSelect;
export type RecurringSubTransaction = typeof recurringSubTransactions.$inferSelect;
export type ScheduledPosting = typeof scheduledPostings.$inferSelect;
export type RenameRule = typeof renameRules.$inferSelect;
export type Setting = typeof settings.$inferSelect;
