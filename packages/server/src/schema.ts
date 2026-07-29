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

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  groupLabel: text("group_label").notNull(),
  balance: numeric("balance", { precision: 14, scale: 2 }).notNull().default("0"),
  onBudget: boolean("on_budget").notNull().default(true),
  sort: integer("sort").notNull().default(0),
});

export const categoryGroups = pgTable("category_groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
  isCreditCardPayments: boolean("is_credit_card_payments").notNull().default(false),
});

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id")
    .notNull()
    .references(() => categoryGroups.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
  carryover: numeric("carryover", { precision: 14, scale: 2 }).notNull().default("0"),
  goalTarget: numeric("goal_target", { precision: 14, scale: 2 }),
  linkedAccountId: integer("linked_account_id").references(() => accounts.id, {
    onDelete: "cascade",
  }),
});

export const assignments = pgTable(
  "assignments",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
  },
  (t) => ({
    uniq: uniqueIndex("assignments_cat_month_uniq").on(t.categoryId, t.month),
  })
);

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
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
  cleared: boolean("cleared").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
  frequency: text("frequency").notNull().default("monthly"),
  nextDate: date("next_date").notNull(),
  active: boolean("active").notNull().default(true),
});

export type Account = typeof accounts.$inferSelect;
export type CategoryGroup = typeof categoryGroups.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Recurring = typeof recurring.$inferSelect;
