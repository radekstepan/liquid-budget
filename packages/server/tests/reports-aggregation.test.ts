import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildReportAggregates,
  computeCashFlowRange,
  computeCashFlowRangeFromAggregates,
  computeMonthlySurplus,
  computeMonthlySurplusFromAggregates,
} from "@ynab/logic";
import * as schema from "../src/schema.js";
import { getBudgetData } from "../src/queries/budget.js";
import {
  getMonthlyAccountDeltas,
  getMonthlyCategoryOutflow,
  getMonthlyIncome,
  getReportAggregates,
} from "../src/queries/reports.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

type TestDb = ReturnType<typeof openMigratedDb>;

function openMigratedDb() {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

async function seedFixture(db: TestDb) {
  const [checking] = await db
    .insert(schema.accounts)
    .values({ name: "Checking", kind: "liquid", groupLabel: "Budget", balance: 0, onBudget: true, sort: 0 })
    .returning();
  const [savings] = await db
    .insert(schema.accounts)
    .values({ name: "Savings", kind: "liquid", groupLabel: "Budget", balance: 0, onBudget: true, sort: 1 })
    .returning();
  const [card] = await db
    .insert(schema.accounts)
    .values({ name: "Card", kind: "credit", groupLabel: "Budget", balance: 0, onBudget: true, sort: 2 })
    .returning();
  const [invest] = await db
    .insert(schema.accounts)
    .values({ name: "Invest", kind: "offbudget", groupLabel: "Tracking", balance: 0, onBudget: false, sort: 3 })
    .returning();

  const [everyday] = await db
    .insert(schema.categoryGroups)
    .values({ name: "Everyday", sort: 0, isCreditCardPayments: false })
    .returning();
  const [ccGroup] = await db
    .insert(schema.categoryGroups)
    .values({ name: "Credit Card Payments", sort: 1, isCreditCardPayments: true })
    .returning();
  const [groceries] = await db
    .insert(schema.categories)
    .values({ groupId: everyday!.id, name: "Groceries", sort: 0 })
    .returning();
  const [dining] = await db
    .insert(schema.categories)
    .values({ groupId: everyday!.id, name: "Dining", sort: 1 })
    .returning();
  await db.insert(schema.categories).values({
    groupId: ccGroup!.id,
    name: "Card Payment",
    sort: 0,
    linkedAccountId: card!.id,
  });

  const t = async (row: typeof schema.transactions.$inferInsert) => {
    const [r] = await db.insert(schema.transactions).values(row).returning();
    return r!;
  };

  // Jan spend + paycheck + internal transfer + boundary outflow + deferred income
  await t({ accountId: checking!.id, date: "2026-01-05", payee: "Store", amount: -5000, categoryId: groceries!.id });
  await t({ accountId: checking!.id, date: "2026-01-10", payee: "Employer", amount: 200000, categoryId: null, isIncome: true });
  await t({ accountId: checking!.id, date: "2026-01-12", payee: "Transfer : Savings", amount: -10000, categoryId: null, transferAccountId: savings!.id });
  await t({ accountId: savings!.id, date: "2026-01-15", payee: "Broker", amount: -30000, categoryId: groceries!.id, transferAccountId: invest!.id });
  await t({ accountId: checking!.id, date: "2026-01-20", payee: "Bonus", amount: 12000, categoryId: null, isIncome: true, incomeMonth: "2026-02" });
  // Feb boundary inflow + spend/refund + split + CC spend + CC payment
  await t({ accountId: invest!.id, date: "2026-02-01", payee: "Withdrawal", amount: 50000, categoryId: null, transferAccountId: checking!.id });
  await t({ accountId: checking!.id, date: "2026-02-03", payee: "Store", amount: -2500, categoryId: groceries!.id });
  await t({ accountId: checking!.id, date: "2026-02-04", payee: "Refund", amount: 1000, categoryId: groceries!.id });
  const parent = await t({ accountId: checking!.id, date: "2026-02-05", payee: "Split", amount: -3000, categoryId: null });
  await t({ accountId: checking!.id, date: "2026-02-05", payee: "Split", amount: -2000, categoryId: groceries!.id, parentId: parent.id });
  await t({ accountId: checking!.id, date: "2026-02-05", payee: "Split", amount: -1000, categoryId: dining!.id, parentId: parent.id });
  await t({ accountId: card!.id, date: "2026-02-10", payee: "Bistro", amount: -4000, categoryId: dining!.id });
  await t({ accountId: checking!.id, date: "2026-02-12", payee: "Transfer : Card", amount: -4000, categoryId: null, transferAccountId: card!.id });
  return { checking: checking!.id, savings: savings!.id, card: card!.id, invest: invest!.id, groceries: groceries!.id, dining: dining!.id };
}

describe("reports SQL aggregation (P1 sql-aggregation)", () => {
  it("returns empty aggregates on an empty budget", async () => {
    const db = openMigratedDb();
    const agg = await getReportAggregates(db);
    expect(agg).toEqual({ outflow: [], income: [], accountDeltas: [] });
  });

  it("SQL group-bys match the pure-JS mirror row-for-row", async () => {
    const db = openMigratedDb();
    await seedFixture(db);
    const data = await getBudgetData(db);
    const expected = buildReportAggregates(data);

    const [outflow, income, deltas] = await Promise.all([
      getMonthlyCategoryOutflow(db),
      getMonthlyIncome(db),
      getMonthlyAccountDeltas(db),
    ]);
    expect(outflow).toEqual(expected.outflow);
    expect(income).toEqual(expected.income);
    expect(deltas).toEqual(expected.accountDeltas);

    const combined = await getReportAggregates(db);
    expect(combined).toEqual(expected);
  });

  it("cash-flow and surplus from aggregates match the full-scan fns", async () => {
    const db = openMigratedDb();
    await seedFixture(db);
    const data = await getBudgetData(db);
    const agg = buildReportAggregates(data);

    for (const [s, e] of [["2026-01", "2026-01"], ["2026-02", "2026-02"], ["2026-01", "2026-02"]] as const) {
      expect(computeCashFlowRangeFromAggregates(agg, s, e)).toEqual(computeCashFlowRange(data, s, e));
    }
    expect(computeMonthlySurplusFromAggregates(agg, "2026-01", "2026-02")).toEqual(
      computeMonthlySurplus(data, "2026-01", "2026-02")
    );

    // Same via the SQL-fetched aggregates (not just the JS mirror).
    const sqlAgg = await getReportAggregates(db);
    expect(computeCashFlowRangeFromAggregates(sqlAgg, "2026-01", "2026-02")).toEqual(
      computeCashFlowRange(data, "2026-01", "2026-02")
    );
  });

  it("month filtering is inclusive and order-insensitive", async () => {
    const db = openMigratedDb();
    await seedFixture(db);
    const febOnly = await getReportAggregates(db, { startMonth: "2026-02", endMonth: "2026-02" });
    expect(febOnly.outflow.every((r) => r.month === "2026-02")).toBe(true);
    expect(
      febOnly.income.every((r) => r.month === "2026-02" || r.incomeMonth === "2026-02")
    ).toBe(true);
    // Deferred January posting budgeted in February rides along via incomeMonth.
    expect(febOnly.income).toContainEqual({ month: "2026-01", incomeMonth: "2026-02", total: 12000 });
    expect(febOnly.accountDeltas.every((r) => r.month === "2026-02")).toBe(true);
    expect(febOnly.outflow.length).toBeGreaterThan(0);

    const swapped = await getReportAggregates(db, { startMonth: "2026-02", endMonth: "2026-01" });
    const ordered = await getReportAggregates(db, { startMonth: "2026-01", endMonth: "2026-02" });
    expect(swapped).toEqual(ordered);
  });

  it("rejects malformed months with 400", async () => {
    const db = openMigratedDb();
    await expect(getReportAggregates(db, { startMonth: "2026-13" })).rejects.toMatchObject({ status: 400 });
    await expect(getMonthlyIncome(db, { endMonth: "not-a-month" })).rejects.toMatchObject({ status: 400 });
  });

  it("income-flagged split parent counts as income, never as outflow", async () => {
    const db = openMigratedDb();
    const ids = await seedFixture(db);
    const parent = (
      await db.insert(schema.transactions).values({
        accountId: ids.checking,
        date: "2026-03-01",
        payee: "YNAB4 inflow",
        amount: 9000,
        categoryId: null,
        isIncome: true,
      }).returning()
    )[0]!;
    await db.insert(schema.transactions).values({
      accountId: ids.checking,
      date: "2026-03-01",
      payee: "YNAB4 inflow leg",
      amount: -500,
      categoryId: ids.groceries,
      parentId: parent.id,
    });
    const agg = await getReportAggregates(db, { startMonth: "2026-03", endMonth: "2026-03" });
    expect(agg.income).toEqual([{ month: "2026-03", incomeMonth: "2026-03", total: 9000 }]);
    // The parent itself contributes no outflow leg; only the child does.
    expect(agg.outflow).toEqual([{ month: "2026-03", categoryId: ids.groceries, total: -500 }]);

    const data = await getBudgetData(db);
    expect(buildReportAggregates(data).income).toContainEqual({
      month: "2026-03",
      incomeMonth: "2026-03",
      total: 9000,
    });
  });

  it("collapses thousands of rows into one GROUP BY row per month+category", async () => {
    const db = openMigratedDb();
    const [account] = await db
      .insert(schema.accounts)
      .values({ name: "Checking", kind: "liquid", groupLabel: "Budget", balance: 0, onBudget: true, sort: 0 })
      .returning();
    const [group] = await db
      .insert(schema.categoryGroups)
      .values({ name: "Everyday", sort: 0, isCreditCardPayments: false })
      .returning();
    const [cat] = await db
      .insert(schema.categories)
      .values({ groupId: group!.id, name: "Groceries", sort: 0 })
      .returning();
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      accountId: account!.id,
      date: `2026-04-${String((i % 28) + 1).padStart(2, "0")}`,
      payee: `Store ${i}`,
      amount: -100,
      categoryId: cat!.id,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(schema.transactions).values(rows.slice(i, i + 500));
    }
    const outflow = await getMonthlyCategoryOutflow(db);
    expect(outflow).toEqual([{ month: "2026-04", categoryId: cat!.id, total: -200000 }]);
    const deltas = await getMonthlyAccountDeltas(db);
    expect(deltas).toEqual([{ month: "2026-04", accountId: account!.id, total: -200000 }]);
  });
});
